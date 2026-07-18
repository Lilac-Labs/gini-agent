"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProviderPicker, type ProviderSaveSummary } from "@/components/ProviderPicker";

export default function AddProviderPage() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const preselect = params.get("provider") ?? "";

  const onSaved = async ({ provider, model, isCodex }: ProviderSaveSummary) => {
    toast.success(isCodex ? "Codex OAuth verified." : `Provider set to ${provider} (${model}).`);
    // Refetch BOTH providers and status BEFORE navigating so the settings list
    // mounts with the row present AND the active-provider transport config (the
    // Edit dialog's prefill source) is fresh. We can't use useInvalidate here —
    // it debounces 80ms and its unmount cleanup clears the pending set when this
    // page unmounts, so the invalidation never fires.
    await Promise.all([
      queryClient.refetchQueries({ queryKey: ["status"] }),
      queryClient.refetchQueries({ queryKey: ["providers"] })
    ]);
    router.push("/settings");
  };

  return (
    <>
      <header className="flex items-center justify-between border-b border-border px-10 py-6">
        <div className="flex items-center gap-4">
          <Button asChild variant="outline" size="icon" aria-label="Back to settings">
            <Link href="/settings">
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Add provider</h1>
            <p className="text-xs text-muted-foreground">Connect a model provider for Gini to use on new chats.</p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings">Cancel</Link>
        </Button>
      </header>

      <div className="flex flex-1 flex-col overflow-auto p-10">
        <ProviderPicker
          preselect={preselect}
          onSaved={onSaved}
          onError={(message) => toast.error(message)}
          secondaryAction={
            <Button asChild variant="outline" type="button">
              <Link href="/settings">Cancel</Link>
            </Button>
          }
        />
      </div>
    </>
  );
}
