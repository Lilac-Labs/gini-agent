"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useInvalidate, type HomeView } from "@/lib/queries";
import type { HomeTaskItem } from "@runtime/types";

// Compact inline answer panel for a needs-input row — deliberately NOT
// BlockSetupRequested (too heavy for a home row): the pending question's
// choice buttons, a one-line free-text input, and an "Open thread →" link.
// A choice with a setupRequestId completes the SetupRequest directly; free
// text with an id completes it as { other }; without an id the answer posts
// as an ordinary chat message (the runtime auto-answers a live needs_input
// run from the message path).
export function HomeNeedsInput({
  containerId,
  needsInput
}: {
  containerId: string;
  needsInput: NonNullable<HomeTaskItem["needsInput"]>;
}) {
  const [text, setText] = useState("");
  const qc = useQueryClient();
  const invalidate = useInvalidate();

  const answer = useMutation({
    mutationFn: (choice: { label: string } | { other: string }) => {
      if (needsInput.setupRequestId) {
        return api(`/setup-requests/${needsInput.setupRequestId}/complete`, {
          method: "POST",
          body: JSON.stringify({ choice })
        });
      }
      const content = "label" in choice ? choice.label : choice.other;
      return api(`/chat/${containerId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content, client: "web" })
      });
    },
    onSuccess: () => {
      // Flip the row to working optimistically — the run resumes server-side
      // and the refetch confirms. Touch every cached agent variant.
      qc.setQueriesData<HomeView>({ queryKey: ["home"] }, (prev) =>
        prev
          ? {
              ...prev,
              tasks: prev.tasks.map((t) =>
                t.id === containerId ? { ...t, attention: "working", needsInput: undefined } : t
              )
            }
          : prev
      );
      invalidate(["home", "chat", "tasks", "setup-requests"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <div className="mt-1 flex flex-col gap-2">
      {needsInput.options && needsInput.options.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {needsInput.options.map((option) => (
            <Button
              key={option}
              variant="outline"
              size="sm"
              disabled={answer.isPending}
              onClick={() => answer.mutate({ label: option })}
            >
              {option}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2.5">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && text.trim().length > 0 && !answer.isPending) {
              event.preventDefault();
              answer.mutate({ other: text.trim() });
            }
          }}
          placeholder="Type an answer"
          disabled={answer.isPending}
          className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring disabled:opacity-60"
        />
        <Link
          href={`/chat?session=${containerId}`}
          className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Open thread →
        </Link>
      </div>
    </div>
  );
}
