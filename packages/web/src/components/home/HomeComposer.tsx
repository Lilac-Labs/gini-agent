"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUp, ChevronDown, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  AttachmentDropOverlay,
  AttachmentTray,
  useAttachments
} from "@/components/chat/attachments";
import { useTopicPanel } from "@/components/chat/TopicPanelContext";
import { useStartTask, useStatus } from "@/lib/queries";
import { composerHighlightWord, highlightedTextParts } from "./HomeComposerHighlight";

type ComposerMode = "task" | "message";

const MODE_STORAGE_KEY = "gini.home.composerMode";

// The "Give Gini a task" composer. Deliberately NOT the chat Composer —
// no stop/queue affordances here — but it copies its autosize,
// Enter/Shift-Enter handling, and attachment machinery (shared
// useAttachments hook) so typing and attaching feel identical. Both modes
// start a container directly (POST /api/containers): Task mode stays on
// home with an optimistic working row; Message mode navigates into the new
// conversation's thread (never the persistent root agent chat).
export function HomeComposer() {
  const router = useRouter();
  const params = useSearchParams();
  const panel = useTopicPanel();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ComposerMode>("task");
  const [highlightWord, setHighlightWord] = useState<string | null>(null);
  const {
    attachments,
    anyUploading,
    readyRefs,
    clearAttachments,
    removeAttachment,
    fileInputRef,
    openFilePicker,
    handleFileChange,
    dragActive,
    dragHandlers,
    handlePaste
  } = useAttachments();

  // The mode chip persists per device. Read after mount (not in the useState
  // initializer) so SSR markup never depends on localStorage.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
      if (stored === "task" || stored === "message") setMode(stored);
    } catch {
      // Disabled storage — keep the default.
    }
  }, []);
  const selectMode = (next: ComposerMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // Quota or disabled storage — keep the in-memory choice.
    }
  };

  // /?compose=message (the sidebar Messages "+") deep-links straight into
  // Message mode, /?compose=task (the routines "Create routine" entry point)
  // into Task mode — textarea focused, then the params are stripped so
  // reload/back-nav doesn't re-trigger. /?prompt=<text> additionally seeds
  // the composer — pre-fill only, never auto-submit; a bare ?prompt= with no
  // compose param keeps the legacy Message-mode seed so external links don't
  // change behavior. Keyed on the params (not mount): clicking "+"
  // while already on home only changes the query string, and the composer
  // never remounts. Declared after the storage read above so the deep link
  // wins the mount race; deliberately transient — it never writes the
  // persisted mode chip.
  useEffect(() => {
    const compose = params?.get("compose");
    const seed = params?.get("prompt");
    const highlight = params?.get("highlight");
    if (compose !== "message" && compose !== "task" && !seed) return;
    setMode(compose === "task" ? "task" : "message");
    if (seed) setText(seed);
    setHighlightWord(composerHighlightWord(highlight));
    const el = textareaRef.current;
    el?.focus();
    // The controlled value only picks up `seed` on the next render, so move
    // the caret to the end after that commit (rAF fires before the next
    // paint); a synchronous setSelectionRange would clamp against the
    // still-empty textarea.
    if (seed && el) {
      requestAnimationFrame(() => el.setSelectionRange(seed.length, seed.length));
    }
    // Shallow URL cleanup (syncs useSearchParams without a router
    // navigation) — router.replace would run Next's navigation focus
    // management and steal the focus just placed on the textarea.
    window.history.replaceState(null, "", "/");
  }, [params]);

  // Auto-grow on value change (the chat Composer idiom).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [text]);

  const status = useStatus();
  const activeAgentId = status.data?.activeAgent?.id;

  const startTask = useStartTask();

  const busy = startTask.isPending;
  // Same content gate as the chat Composer: text or at least one uploaded
  // attachment, nothing still uploading. Both modes wait for the status probe
  // to resolve the agent id: submitting in the pre-status window would write
  // the optimistic row under the ["home", null] cache key and POST
  // /containers without an agentId.
  const hasContent = text.trim().length > 0 || readyRefs().length > 0;
  const canSend = !busy && !anyUploading && hasContent && Boolean(activeAgentId);

  const submit = () => {
    if (!canSend) return;
    const content = text.trim();
    const images = readyRefs();
    // Clear immediately — the optimistic row (Task mode) / navigation
    // (Message mode) is the feedback; text restored on error. The tray is
    // not restored (its previews are revoked here), matching the chat
    // Composer — the uploads themselves survive server-side.
    setText("");
    clearAttachments();
    const messageMode = mode === "message";
    startTask.mutate(
      // startedAs records the creation gesture: the sidebar Messages section
      // lists startedAs === "message" containers; Task-mode mints stay home
      // work items only.
      { content, images, startedAs: messageMode ? "message" : "task" },
      {
        onSuccess: (data) => {
          // Message mode opens the new conversation's own thread full-page;
          // Task mode stays on home and opens the new container in the
          // right-side topic panel so the user watches the turn in place
          // (the optimistic Tasks row lands alongside).
          setHighlightWord(null);
          if (messageMode) router.push(`/chat?session=${data.containerId}`);
          else panel?.openTopic(data.containerId);
        },
        onError: (error) => {
          setText(content);
          toast.error(error.message);
        }
      }
    );
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const highlightParts = highlightedTextParts(text, highlightWord);

  return (
    // suppressHydrationWarning (shell + textarea): password-manager extensions
    // (e.g. Dashlane's data-dashlane-rid) stamp attributes here before React
    // hydrates; without the extension the flag is inert. The data-* hints tell
    // 1Password/LastPass/Bitwarden/Dashlane to skip this non-credential field.
    <div
      {...dragHandlers}
      suppressHydrationWarning
      className={cn(
        "relative rounded-[24px] border border-border bg-card px-[18px] pt-4 pb-3 shadow-sm transition-colors",
        dragActive && "border-primary bg-accent"
      )}
    >
      <AttachmentDropOverlay active={dragActive} />
      <AttachmentTray attachments={attachments} onRemove={removeAttachment} />
      <div className="relative">
        {highlightParts ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 whitespace-pre-wrap break-words text-sm leading-snug text-foreground"
          >
            {highlightParts[0]}
            <span className="inline-flex items-center gap-1 rounded-full bg-[#E7F0FF] px-2 py-0.5 font-medium text-[#1769FF]">
              <span className="size-1.5 rounded-full bg-current" />
              {highlightParts[1]}
            </span>
            {highlightParts[2]}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={mode === "task" ? "Give Gini a task" : "Ask Gini anything"}
          suppressHydrationWarning
          data-1p-ignore=""
          data-lpignore="true"
          data-bwignore=""
          data-form-type="other"
          className={cn(
            "relative block max-h-32 w-full resize-none border-0 bg-transparent text-sm leading-snug outline-none placeholder:text-muted-foreground",
            highlightParts && "text-transparent caret-foreground"
          )}
        />
      </div>
      <div className="mt-3.5 flex items-center gap-3.5">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          type="button"
          onClick={openFilePicker}
          aria-label="Attach file"
          className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Paperclip className="size-4" />
        </button>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {mode === "task" ? "Task" : "Message"}
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => selectMode("task")}>Task</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => selectMode("message")}>Message</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={submit}
          aria-label="Send"
          disabled={!canSend}
          className="flex size-[34px] items-center justify-center rounded-full bg-sidebar-primary text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  );
}
