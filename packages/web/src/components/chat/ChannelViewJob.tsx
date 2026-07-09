"use client";

import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowUpRight } from "lucide-react";
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";

// Header pill on a recurring-job channel that opens the originating job.
// Switches the active agent to the job's owning agent when it differs (mirrors
// the sidebar's agent-switch mutation), then deep-links the job's routine
// detail page (/routines/job/<id> forwards template installs to their
// template detail itself).
export function ChannelViewJob({
  jobId,
  agentId,
  activeAgentId
}: {
  jobId: string;
  agentId?: string;
  activeAgentId?: string;
}) {
  const router = useRouter();
  const invalidate = useInvalidate();

  const useAgentMutation = useMutation({
    mutationFn: (id: string) => api(`/agents/${encodeURIComponent(id)}/use`, { method: "POST" }),
    onSuccess: () => invalidate(["agents", "state", "status", "memory", "agent-chat"])
  });

  const onClick = async () => {
    if (agentId && agentId !== activeAgentId) {
      try {
        await useAgentMutation.mutateAsync(agentId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to switch agent");
      }
    }
    router.push(`/routines/job/${encodeURIComponent(jobId)}`);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      View routine
      <ArrowUpRight className="size-3.5" />
    </button>
  );
}
