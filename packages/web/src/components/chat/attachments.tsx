"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { uploadImage, type UploadRef } from "@/lib/api";

// Composer attachment machinery shared by the chat Composer and the
// HomeComposer: pick/drop/paste a file, upload it to the gateway, preview it
// in a tray, and hand the resulting UploadRefs to the submit path. Both
// composers render the same tray and submit the same `images` payload field.

export interface PendingAttachment {
  // Local id used to track the item in the list while it uploads. Replaced
  // by the server-assigned UploadRef.id on success.
  localId: string;
  kind: "image" | "file";
  // Object-URL preview, created only for images (the tray renders a
  // thumbnail from it). Non-image files render a chip and have none, so
  // there's nothing to revoke for them.
  previewUrl?: string;
  filename: string;
  size: number;
  status: "uploading" | "ready" | "error";
  errorMessage?: string;
  ref?: UploadRef;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function hasFiles(event: React.DragEvent<HTMLDivElement>): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === "Files") return true;
  }
  return false;
}

export function useAttachments() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);

  // Revoke object URLs on unmount. Browsers leak the blob until
  // revokeObjectURL is called; the ref keeps the cleanup closure current.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => {
    return () => {
      for (const attachment of attachmentsRef.current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);

  const readyRefs = (): UploadRef[] =>
    attachments.filter((attachment) => attachment.ref).map((attachment) => attachment.ref!);
  const anyUploading = attachments.some((attachment) => attachment.status === "uploading");

  const beginUpload = async (file: File): Promise<void> => {
    const localId = crypto.randomUUID();
    const isImage = file.type.startsWith("image/");
    // Only images get a thumbnail preview; an object URL for a non-image
    // file would never be rendered, so skip it (and skip revoking later).
    const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
    setAttachments((prev) => [
      ...prev,
      {
        localId,
        kind: isImage ? "image" : "file",
        previewUrl,
        filename: file.name,
        size: file.size,
        status: "uploading"
      }
    ]);
    try {
      const ref = await uploadImage(file);
      setAttachments((prev) =>
        prev.map((attachment) =>
          attachment.localId === localId ? { ...attachment, status: "ready", ref } : attachment
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Upload failed: ${message}`);
      setAttachments((prev) =>
        prev.map((attachment) =>
          attachment.localId === localId
            ? { ...attachment, status: "error", errorMessage: message }
            : attachment
        )
      );
    }
  };

  const addFiles = (files: FileList | File[]): void => {
    const list = Array.from(files);
    if (list.length === 0) return;
    for (const file of list) void beginUpload(file);
  };

  const removeAttachment = (localId: string): void => {
    setAttachments((prev) => {
      const next = prev.filter((attachment) => attachment.localId !== localId);
      const removed = prev.find((attachment) => attachment.localId === localId);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  };

  // Reset the tray after the refs are handed to the submit path — the
  // uploads live server-side now; only the local previews need revoking.
  const clearAttachments = (): void => {
    for (const attachment of attachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    setAttachments([]);
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    // Reset so the same file can be picked twice in a row.
    event.target.value = "";
  };

  const dragHandlers = {
    onDragEnter: (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragActive(true);
    },
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragActive(false);
    },
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragActive(false);
      if (event.dataTransfer.files) addFiles(event.dataTransfer.files);
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of event.clipboardData.items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  };

  return {
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
  };
}

// Full-composer "Drop file to attach" affordance while a file drag hovers the
// shell. The host div must be `relative` (the overlay fills it).
export function AttachmentDropOverlay({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[24px] border-2 border-dashed border-primary bg-background/80 text-sm font-medium text-primary">
      Drop file to attach
    </div>
  );
}

export function AttachmentTray({
  attachments,
  onRemove
}: {
  attachments: PendingAttachment[];
  onRemove: (localId: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-2">
      {attachments.map((attachment) =>
        attachment.kind === "image" ? (
          <li
            key={attachment.localId}
            className={cn(
              "relative size-16 overflow-hidden rounded-lg border bg-background",
              attachment.status === "error" && "border-destructive"
            )}
            title={attachment.filename}
          >
            <img
              src={attachment.previewUrl}
              alt={attachment.filename}
              className="size-full object-cover"
            />
            {attachment.status === "uploading" ? (
              <div className="absolute inset-0 flex items-center justify-center bg-background/60 text-[10px] font-medium uppercase text-muted-foreground">
                Uploading…
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => onRemove(attachment.localId)}
              aria-label={`Remove ${attachment.filename}`}
              className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm hover:bg-background"
            >
              <X className="size-3" />
            </button>
          </li>
        ) : (
          <li
            key={attachment.localId}
            className={cn(
              "relative flex h-16 w-48 items-center gap-2 overflow-hidden rounded-lg border bg-background px-3",
              attachment.status === "error" && "border-destructive"
            )}
            title={attachment.filename}
          >
            <FileText className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-foreground">
                {attachment.filename}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {attachment.status === "uploading" ? "Uploading…" : formatBytes(attachment.size)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onRemove(attachment.localId)}
              aria-label={`Remove ${attachment.filename}`}
              className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm hover:bg-background"
            >
              <X className="size-3" />
            </button>
          </li>
        )
      )}
    </ul>
  );
}
