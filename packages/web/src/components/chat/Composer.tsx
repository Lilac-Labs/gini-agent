"use client";

import { useEffect, useRef } from "react";
import { Paperclip, Send, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { uploadUrl, type UploadRef } from "@/lib/api";
import {
  AttachmentDropOverlay,
  AttachmentTray,
  useAttachments
} from "@/components/chat/attachments";

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (images: UploadRef[]) => void;
  busy?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  placeholder?: string;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  onStop,
  disabled,
  placeholder = "Ask anything"
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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

  // Auto-grow on value change.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [value]);

  const hasContent = value.trim().length > 0 || readyRefs().length > 0;
  // Submission is allowed even while a turn is in flight — the message is
  // queued server-side (ADR chat-message-queue.md). It is gated only on having
  // content, nothing uploading, and the composer not being hard-disabled.
  const canSubmit = !disabled && !anyUploading && hasContent;
  // The Send button only shows when not busy; it stays gated on content.
  const canSend = !busy && canSubmit;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(readyRefs());
    clearAttachments();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div
      {...dragHandlers}
      // suppressHydrationWarning (shell + textarea): password-manager
      // extensions (e.g. Dashlane's data-dashlane-rid) stamp attributes here
      // before React hydrates; without the extension the flag is inert. The
      // data-* hints on the textarea tell 1Password/LastPass/Bitwarden/
      // Dashlane to skip this non-credential field.
      suppressHydrationWarning
      className={cn(
        "relative rounded-[24px] border bg-muted px-4 py-3 shadow-sm transition-colors",
        dragActive && "border-primary bg-accent"
      )}
    >
      <AttachmentDropOverlay active={dragActive} />
      <AttachmentTray attachments={attachments} onRemove={removeAttachment} />

      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={placeholder}
        disabled={disabled}
        suppressHydrationWarning
        data-1p-ignore=""
        data-lpignore="true"
        data-bwignore=""
        data-form-type="other"
        className="block max-h-32 w-full resize-none border-0 bg-transparent text-sm leading-snug outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />
      <div className="mt-2 flex items-center justify-between">
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
          disabled={disabled}
          className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Paperclip className="size-4" />
        </button>
        {busy ? (
          <button
            type="button"
            onClick={() => onStop?.()}
            aria-label="Stop"
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-full text-white transition-colors",
              "bg-destructive hover:opacity-90"
            )}
          >
            <Square className="size-3.5" fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            aria-label="Send"
            disabled={!canSend}
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity",
              "disabled:cursor-not-allowed disabled:opacity-40 hover:opacity-90"
            )}
          >
            <Send className="size-4 -translate-x-px translate-y-px" />
          </button>
        )}
      </div>
    </div>
  );
}

// Re-uploads using the runtime path. (Kept here so the file's only effect on
// the BFF surface is via /api/runtime/api/uploads — see uploadUrl().)
export { uploadUrl };
