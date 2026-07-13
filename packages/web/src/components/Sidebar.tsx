"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Home,
  Menu,
  Moon,
  MoreHorizontal,
  Plug,
  Plus,
  RefreshCw,
  Repeat,
  ScrollText,
  Settings,
  Sun,
  Trash2,
  Users,
  WandSparkles
} from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAllChatSessions, useInvalidate, useManagedMode, useStatus } from "@/lib/queries";
import { useChatReadState } from "@/lib/use-chat-read-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { CreateAgentDialog } from "@/components/CreateAgentDialog";
import { ArchiveAgentDialog } from "@/components/ArchiveAgentDialog";
import { DeleteAgentDialog } from "@/components/DeleteAgentDialog";
import { TunnelMenu } from "@/components/tunnel/TunnelMenu";
import { useUpdateGate } from "@/components/UpdateGate";
import type { AgentRow, ChatSession } from "@/lib/view-types";

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const invalidate = useInvalidate();
  const [createOpen, setCreateOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<AgentRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentRow | null>(null);
  const [deleteMessageTarget, setDeleteMessageTarget] = useState<ChatSession | null>(null);
  const [topicsCollapsed, toggleTopics] = useSectionCollapsed("topics");
  const [messagesCollapsed, toggleMessages] = useSectionCollapsed("messages");

  const status = useStatus();
  // Managed (platform-hosted) deployments hide the self-serve footer: the
  // tunnel menu (ingress is platform-provided) and the self-update row
  // (updates are platform-rolled). Absent/failed answers render the footer —
  // self-hosted behavior is the default. See ADR managed-deployment-mode.md.
  const managed = useManagedMode().data?.managed === true;
  const activeAgentId = status.data?.activeAgent?.id;
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string; defaultAgentId?: string }>("/agents")
  });
  const allAgents = agentsQuery.data?.agents ?? [];
  const defaultAgentId = agentsQuery.data?.defaultAgentId;
  // `archivedAt` is a soft-delete marker, orthogonal to `status`. Split the
  // roster so archived agents render in their own collapsible group instead
  // of the active list.
  const agents = useMemo(() => allAgents.filter((a) => !a.archivedAt), [allAgents]);
  const archivedAgents = useMemo(() => allAgents.filter((a) => a.archivedAt), [allAgents]);
  const activeAgentName =
    status.data?.activeAgent?.name ??
    allAgents.find((a) => a.id === activeAgentId)?.name ??
    "Gini";

  // Channel read-state is a constant union across all agents, so it sources
  // from an unscoped fetch rather than the active-agent-scoped useChatSessions.
  const allSessions = useAllChatSessions();

  // Topics for the active agent: pinned containers only (pinning is a user
  // gesture; legacy topics were pinned by the gateway migration). Unpinned
  // work-item containers surface on home, never here. Newest-activity first
  // so the most recently touched subject sits on top; scoped to the active
  // agent (each Topic belongs to that agent's Chat) so the section tracks
  // the selected agent, like the Chats/agent rows.
  const topics = useMemo<ChatSession[]>(() => {
    return (allSessions.data ?? [])
      .filter(
        (s) =>
          s.pinned === true &&
          !s.archivedAt &&
          (activeAgentId == null || s.agentId === activeAgentId)
      )
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }, [allSessions.data, activeAgentId]);

  // Chats: the user's active conversations — unpinned (pinning promotes a
  // conversation into Topics), non-archived, non-headless, agent-scoped like
  // Topics. Two kinds of rows qualify:
  //   - conversations the user started by hand in the composer's Chat
  //     mode (startedAs === "message", no spawnedByTaskId, origin !== "job"
  //     — router/agent-minted containers stay off the chrome, Task-mode
  //     mints stay home work items only, and containers predating the field
  //     drop out of the section)
  //   - job delivery channels (kind:"channel" + origin:"job") — a routine's
  //     dedicated conversation (ADR routine-templates-gallery.md) or a
  //     create_job dedicated session, where scheduled fires deliver.
  //     Email-watch channels stay out: that subsystem owns its channels and
  //     the routines page deep-links them via Open channel.
  // Newest activity first, capped to keep the section scannable.
  const messages = useMemo<ChatSession[]>(() => {
    return (allSessions.data ?? [])
      .filter(
        (s) =>
          (s.kind === "topic" || s.kind === "channel") &&
          s.pinned !== true &&
          !s.archivedAt &&
          s.headless !== true &&
          (activeAgentId == null || s.agentId === activeAgentId) &&
          ((s.startedAs === "message" && !s.spawnedByTaskId && s.origin !== "job") ||
            (s.kind === "channel" && s.origin === "job" && s.feature === undefined))
      )
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, 15);
  }, [allSessions.data, activeAgentId]);

  const { isUnread } = useChatReadState(allSessions.data);

  const selectedSession = params?.get("session") ?? null;
  const onChat = pathname === "/chat";

  const useAgentMutation = useMutation({
    mutationFn: (id: string) => api(`/agents/${encodeURIComponent(id)}/use`, { method: "POST" }),
    onSuccess: () => invalidate(["agents", "state", "status", "memory", "agent-chat"]),
    onError: (error: Error) => toast.error(error.message)
  });

  // Restore is a direct, no-confirm action: the restored agent rejoins the
  // active list but stays inactive (the server never auto-activates it).
  const unarchiveMutation = useMutation({
    mutationFn: (id: string) => api(`/agents/${encodeURIComponent(id)}/unarchive`, { method: "POST" }),
    onSuccess: () => invalidate(["agents", "state", "status"]),
    onError: (error: Error) => toast.error(error.message)
  });

  // If the archived/deleted conversation is the one currently on screen,
  // step away from it: close the home panel (shallow URL, the closeTopic
  // idiom in app/page.tsx) or leave its /chat surface for home.
  const closeIfOpen = (sessionId: string) => {
    if (pathname === "/chat" && params?.get("session") === sessionId) {
      router.push("/");
    } else if (pathname === "/" && params?.get("panel") === sessionId) {
      window.history.replaceState(null, "", "/");
    }
  };

  // Archive is immediate (no confirm): the conversation leaves the section
  // but keeps its history and stays reachable by deep link.
  const archiveMessageMutation = useMutation({
    mutationFn: (session: ChatSession) =>
      api(`/containers/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true })
      }),
    onSuccess: (_data, session) => {
      toast.success(`"${session.title}" archived`);
      invalidate(["chat", "home", "state"]);
      closeIfOpen(session.id);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const selectAgent = (id: string) => {
    if (id !== activeAgentId) useAgentMutation.mutate(id);
    // The bare-/chat root surface is hidden from the chrome for now, so an
    // agent switch lands on home rather than the agent's persistent chat.
    router.push("/");
    onNavigate?.();
  };
  const selectChannel = (sessionId: string) => {
    router.push(`/chat?session=${sessionId}`);
    onNavigate?.();
  };

  const navItem = (
    active: boolean
  ): string =>
    cn(
      "flex items-center gap-3 rounded-lg px-2.5 py-[9px] text-[13px] font-medium transition-colors",
      active
        ? "bg-sidebar-accent text-sidebar-accent-foreground"
        : "text-sidebar-foreground hover:bg-sidebar-accent/50"
    );

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-1.5 px-3 pt-[18px] pb-2">
        <Link href="/" onClick={onNavigate} aria-label="Home" className="flex shrink-0 items-center">
          <Image src="/gini-agent-logo.png" alt="Gini" width={20} height={20} unoptimized className="size-5 shrink-0" />
        </Link>
        <DropdownMenu open={agentMenuOpen} onOpenChange={setAgentMenuOpen}>
          <DropdownMenuTrigger className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-sidebar-accent/50">
            <span className="min-w-0 truncate text-sm font-semibold text-sidebar-accent-foreground">
              {activeAgentName}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {agents.map((agent) => {
              const active = agent.id === activeAgentId;
              const canArchive = agent.id !== defaultAgentId;
              return (
                <div key={agent.id} className="group relative">
                  <DropdownMenuItem onSelect={() => selectAgent(agent.id)} className="pr-8">
                    <AgentAvatar name={agent.name} seed={agent.id} size={18} initialColor="#0A0A0C" />
                    <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                    {active ? <Check className="size-3.5 shrink-0 text-sidebar-foreground/60" /> : null}
                  </DropdownMenuItem>
                  {canArchive ? (
                    <button
                      type="button"
                      aria-label={`Archive ${agent.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        setAgentMenuOpen(false);
                        setArchiveTarget(agent);
                      }}
                      className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/60 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Archive className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              );
            })}
            {archivedAgents.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <div className="px-2 py-1 text-[11px] font-semibold tracking-[0.5px] text-sidebar-foreground/55">
                  Archived
                </div>
                {archivedAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className="group relative flex items-center gap-2 rounded-sm px-2 py-1.5 opacity-70"
                  >
                    <AgentAvatar name={agent.name} seed={agent.id} size={18} initialColor="#0A0A0C" />
                    <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/70">
                      {agent.name}
                    </span>
                    <button
                      type="button"
                      aria-label={`Restore ${agent.name}`}
                      disabled={unarchiveMutation.isPending}
                      onClick={() => unarchiveMutation.mutate(agent.id)}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-50"
                    >
                      <ArchiveRestore className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${agent.name}`}
                      onClick={() => {
                        setAgentMenuOpen(false);
                        setDeleteTarget(agent);
                      }}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setCreateOpen(true)}>+ New agent</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />
        {mounted ? (
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label="Toggle theme"
            className="flex size-[22px] items-center justify-center rounded-md border border-sidebar-border bg-transparent text-sidebar-foreground/70"
          >
            {theme === "dark" ? <Sun className="size-3" /> : <Moon className="size-3" />}
          </button>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-[18px] px-3 py-2">
          {/* Home — the daily surface */}
          <ul className="flex flex-col gap-0.5">
            <li>
              <Link href="/" onClick={onNavigate} className={navItem(pathname === "/")}>
                <Home className="size-3.5 text-sidebar-foreground/70" />
                Home
              </Link>
            </li>
          </ul>

          <div className="h-px bg-sidebar-border" />

          {/* Chats — the user's active (unpinned) conversations. The
              section is always present (even with no conversations) so the
              header and "New chat" affordance stay reachable; an empty
              list shows a muted placeholder instead of collapsing away. */}
          <>
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between px-2">
                  <button
                    type="button"
                    onClick={toggleMessages}
                    aria-expanded={!messagesCollapsed}
                    className="flex items-center gap-1.5 text-sidebar-foreground/55 hover:text-sidebar-foreground/80"
                  >
                    <ChevronDown
                      className={cn("size-3 transition-transform", messagesCollapsed && "-rotate-90")}
                    />
                    <span className="text-[11px] font-semibold tracking-[0.5px]">Chats</span>
                  </button>
                  <button
                    type="button"
                    aria-label="New chat"
                    onClick={() => {
                      router.push("/?compose=message");
                      onNavigate?.();
                    }}
                    className="flex size-5 items-center justify-center rounded-md text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/80"
                  >
                    <Plus className="size-3.5" />
                  </button>
                </div>
                <ul className={cn("flex flex-col gap-0.5", messagesCollapsed && "hidden")}>
                  {messages.length === 0 ? (
                    <li className="px-2.5 py-2 text-[13px] text-sidebar-foreground/45">
                      No chats yet
                    </li>
                  ) : null}
                  {messages.map((session) => {
                    const active = onChat && selectedSession === session.id;
                    const unread = !active && isUnread(session);
                    return (
                      // The row is a <button>, so the hover actions trigger
                      // can't nest inside it (invalid HTML) — it floats over
                      // the row's right edge instead, the same absolute-
                      // overlay idiom as the agent-list archive button above.
                      <li key={session.id} className="group/row relative">
                        <button
                          type="button"
                          onClick={() => selectChannel(session.id)}
                          className={cn(
                            "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                            active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"
                          )}
                        >
                          <span
                            aria-hidden
                            className="w-3.5 shrink-0 text-center text-sm font-medium text-sidebar-foreground/55"
                          >
                            #
                          </span>
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-[13px]",
                              active || unread
                                ? "font-semibold text-sidebar-accent-foreground"
                                : "font-medium text-sidebar-foreground"
                            )}
                          >
                            {session.title}
                          </span>
                          {unread ? (
                            <span
                              aria-hidden
                              className="size-[7px] shrink-0 rounded-full bg-sidebar-primary group-hover/row:opacity-0"
                            />
                          ) : null}
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={`Actions for ${session.title}`}
                              className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/60 opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
                            >
                              <MoreHorizontal className="size-3.5" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="w-40">
                            <DropdownMenuItem
                              onSelect={() => archiveMessageMutation.mutate(session)}
                            >
                              <Archive className="size-3.5" />
                              Archive
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setDeleteMessageTarget(session)}
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
              </div>
              <div className="h-px bg-sidebar-border" />
            </>

          {/* Topics */}
          {topics.length > 0 ? (
            <>
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between px-2">
                  <button
                    type="button"
                    onClick={toggleTopics}
                    aria-expanded={!topicsCollapsed}
                    className="flex items-center gap-1.5 text-sidebar-foreground/55 hover:text-sidebar-foreground/80"
                  >
                    <ChevronDown
                      className={cn("size-3 transition-transform", topicsCollapsed && "-rotate-90")}
                    />
                    <span className="text-[11px] font-semibold tracking-[0.5px]">Topics</span>
                  </button>
                </div>
                <ul className={cn("flex flex-col gap-0.5", topicsCollapsed && "hidden")}>
                  {topics.map((topic) => {
                    const active = onChat && selectedSession === topic.id;
                    const unread = !active && isUnread(topic);
                    return (
                      <li key={topic.id}>
                        <button
                          type="button"
                          onClick={() => selectChannel(topic.id)}
                          className={cn(
                            "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                            active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"
                          )}
                        >
                          <span
                            aria-hidden
                            className="w-3.5 shrink-0 text-center text-sm font-medium text-sidebar-foreground/55"
                          >
                            #
                          </span>
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-[13px]",
                              active || unread
                                ? "font-semibold text-sidebar-accent-foreground"
                                : "font-medium text-sidebar-foreground"
                            )}
                          >
                            {topic.title}
                          </span>
                          {unread ? (
                            <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-sidebar-primary" />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="h-px bg-sidebar-border" />
            </>
          ) : null}

          {/* Nav: People, Routines, Skills, Integrations, Logs, Settings */}
          <ul className="flex flex-col gap-0.5">
            <li>
              <Link href="/people" onClick={onNavigate} className={navItem(pathname === "/people")}>
                <Users className="size-3.5 text-sidebar-foreground/70" />
                People
              </Link>
            </li>
            <li>
              <Link href="/routines" onClick={onNavigate} className={navItem(pathname === "/routines")}>
                <Repeat className="size-3.5 text-sidebar-foreground/70" />
                Routines
              </Link>
            </li>
            <li>
              <Link href="/skills" onClick={onNavigate} className={navItem(pathname === "/skills")}>
                <WandSparkles className="size-3.5 text-sidebar-foreground/70" />
                Skills
              </Link>
            </li>
            <li>
              <Link href="/integrations" onClick={onNavigate} className={navItem(pathname === "/integrations")}>
                <Plug className="size-3.5 text-sidebar-foreground/70" />
                Integrations
              </Link>
            </li>
            <li>
              <Link href="/logs" onClick={onNavigate} className={navItem(pathname === "/logs")}>
                <ScrollText className="size-3.5 text-sidebar-foreground/70" />
                Logs
              </Link>
            </li>
            <li>
              <Link href="/settings" onClick={onNavigate} className={navItem(pathname === "/settings")}>
                <Settings className="size-3.5 text-sidebar-foreground/70" />
                Settings
              </Link>
            </li>
          </ul>
        </div>
      </ScrollArea>

      {managed ? null : (
        <>
          <div className="px-3 pb-2 pt-3">
            <TunnelMenu />
          </div>
          <div className="h-px bg-sidebar-border" />
          <UpdateReminder />
        </>
      )}
      <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ArchiveAgentDialog
        agent={archiveTarget}
        open={archiveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null);
        }}
      />
      <DeleteAgentDialog
        agent={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      />
      <DeleteConversationDialog
        session={deleteMessageTarget}
        open={deleteMessageTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteMessageTarget(null);
        }}
        onDeleted={(sessionId) => {
          invalidate(["chat", "home", "state"]);
          closeIfOpen(sessionId);
        }}
      />
    </div>
  );
}

// Confirm-then-delete for a sidebar Chats row (DELETE /api/containers/:id)
// — the DeleteAgentDialog pattern. The server refuses while a run is live
// (409); the error text surfaces in the toast so the user knows to let the
// run finish (or cancel it) first.
function DeleteConversationDialog({
  session,
  open,
  onOpenChange,
  onDeleted
}: {
  session: ChatSession | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (sessionId: string) => void;
}) {
  const remove = useMutation({
    mutationFn: (id: string) => api(`/containers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      toast.success(session ? `"${session.title}" deleted` : "Conversation deleted");
      onOpenChange(false);
      onDeleted(id);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {session ? `"${session.title}"` : "this conversation"}?</DialogTitle>
          <DialogDescription>
            This permanently deletes the conversation and its full history. This can&apos;t be
            undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => session && remove.mutate(session.id)}
            disabled={remove.isPending}
          >
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useMounted() {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false
  );
}

// Per-device collapse state for sidebar sections, persisted in localStorage so
// a collapsed section stays collapsed across reloads. Mirrors the
// useSyncExternalStore + localStorage idiom used for chat/thread read state.
const COLLAPSE_STORAGE_KEY = "gini.sidebar.collapsed";

type CollapseMap = Record<string, boolean>;
let collapseCache: CollapseMap | null = null;
const collapseListeners = new Set<() => void>();

function readCollapse(): CollapseMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as CollapseMap;
    }
  } catch {
    // Corrupt or disabled storage — fall through to default.
  }
  return {};
}

function getCollapse(): CollapseMap {
  if (collapseCache === null) collapseCache = readCollapse();
  return collapseCache;
}

function toggleCollapse(key: string) {
  const current = getCollapse();
  const next = { ...current, [key]: !current[key] };
  collapseCache = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota or disabled storage — keep the in-memory toggle, skip persisting.
    }
  }
  for (const listener of collapseListeners) listener();
}

function subscribeCollapse(listener: () => void) {
  collapseListeners.add(listener);
  return () => {
    collapseListeners.delete(listener);
  };
}

const EMPTY_COLLAPSE: CollapseMap = {};

function useSectionCollapsed(key: string): [boolean, () => void] {
  const map = useSyncExternalStore(subscribeCollapse, getCollapse, () => EMPTY_COLLAPSE);
  return [map[key] === true, () => toggleCollapse(key)];
}

// The update lifecycle (mutation, polling, the full-app blur overlay) lives in
// UpdateGateProvider; this row is just its trigger + version line. The button
// hides once an update is in flight because the gate's overlay takes over.
function UpdateReminder() {
  const { version, updateSupported, updateAvailable, phase, start } = useUpdateGate();
  const showUpdate = updateAvailable && phase === "idle";

  return (
    <div className="flex items-center justify-between gap-2 px-3 pb-[18px] pt-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="truncate text-[11px] font-medium text-sidebar-foreground/55">
          v{version?.packageVersion ?? "0.0.0"}{version?.git.shortSha ? ` · ${version.git.shortSha}` : ""}
        </div>
        {showUpdate ? (
          <div className="text-[11px] font-medium text-sidebar-accent-foreground">Update ready</div>
        ) : (
          <div className="text-[11px] font-medium text-sidebar-foreground/55">Gini agent</div>
        )}
      </div>
      {showUpdate ? (
        <button
          type="button"
          disabled={!updateSupported}
          onClick={start}
          className="flex shrink-0 items-center gap-1.5 rounded-[7px] border border-sidebar-border bg-sidebar-accent px-[11px] py-[7px] text-xs font-semibold text-sidebar-accent-foreground disabled:opacity-60"
        >
          <RefreshCw className="size-[13px] text-sidebar-foreground/80" />
          Update
        </button>
      ) : null}
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden h-full w-[266px] shrink-0 border-r border-sidebar-border md:flex md:flex-col">
      <SidebarBody />
    </aside>
  );
}

export function MobileTopBar() {
  const [open, setOpen] = useState(false);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button size="icon" variant="ghost" className="h-9 w-9" aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-[266px] p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <SidebarBody onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <span className="text-sm font-semibold">Gini</span>
    </header>
  );
}
