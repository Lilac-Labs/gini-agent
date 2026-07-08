"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useInvalidate, useStatus } from "@/lib/queries";
import { ModelPicker, type ModelSelection } from "@/components/ModelPicker";
import type { AgentRow } from "@/lib/view-types";

interface AgentProviderResult {
  id: string;
  providerName?: string;
  model?: string;
}

// "Agent model" — the model the ACTIVE agent's chats and memory LLM calls
// use. Picking a model in the ModelPicker saves the agent's provider/model
// override immediately (the exact { provider, model } route pair —
// resolveEffectiveContext reads it; see ADRs per-agent-provider-settings.md
// and model-first-selection.md). Agents are snapshots, not live links: "Use
// default model" copies the CURRENT default pair onto the agent as a new
// pin — it never clears the override, so a later default change can't
// silently move this agent. Credential setup (API keys, AWS, Codex) stays
// in the provider rows below; the picker only offers routes through
// already-configured providers.
//
// Both the mutation target and the displayed current selection come from
// `/status.activeAgent`, so the read and the write always refer to the same
// agent.
export function AgentModelControl() {
  const status = useStatus();
  const invalidate = useInvalidate();
  // The default agent's pair is the default model ("Use default model"
  // copies it). Legacy instances carry the pre-rename "profile_default" id.
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string }>("/agents")
  });
  const defaultAgent =
    agents.data?.agents.find((agent) => agent.id === "agent_default") ??
    agents.data?.agents.find((agent) => agent.id === "profile_default");

  const activeAgent = status.data?.activeAgent;
  const agentId = activeAgent?.id;
  // The instance fallback an override-less agent resolves through.
  const instanceProvider = status.data?.provider?.provider;
  // The agent's CURRENT effective selection — pinned or inherited.
  const resolved = activeAgent?.resolvedProvider;
  const value: ModelSelection | null = resolved
    ? { provider: resolved.name, model: resolved.model }
    : null;
  // The current default pair — what "Use default model" copies onto the
  // agent. The default agent's pair is authoritative; the instance provider
  // is the pre-seed fallback.
  const defaultPair: ModelSelection | null =
    defaultAgent?.providerName && defaultAgent.model
      ? { provider: defaultAgent.providerName, model: defaultAgent.model }
      : instanceProvider
        ? { provider: instanceProvider.name, model: instanceProvider.model }
        : null;
  // "profile_default" is the legacy pre-rename id for the default agent.
  const isDefaultAgent = agentId === "agent_default" || agentId === "profile_default";
  // An override-less agent still resolves through config.provider live (the
  // runtime fallback); the next default change pins it where it stands.
  const isFollowing = !isDefaultAgent && activeAgent?.providerSource !== "agent";

  const save = useMutation({
    // The default agent's pair IS the default model, so its picks route
    // through the two-layer default-model write — a bare agent-override
    // write would move what new chats start with while config.provider
    // (embeddings/reranker anchor, provider-removal gate) stayed behind.
    // Other agents save their own pinned pair.
    mutationFn: (vars: { providerName: string; model: string }) =>
      isDefaultAgent
        ? api("/settings/default-model", {
            method: "POST",
            body: JSON.stringify({ provider: vars.providerName, model: vars.model })
          })
        : api<AgentProviderResult>(`/agents/${encodeURIComponent(agentId ?? "")}/provider`, {
            method: "POST",
            body: JSON.stringify(vars)
          }),
    onSuccess: (_result, vars) => {
      toast.success(
        isDefaultAgent
          ? `Default model: ${vars.model} via ${vars.providerName}`
          : `${vars.model} via ${vars.providerName} for this agent`
      );
      invalidate(["status", "agents", "state", "providers"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">Agent model</h2>
        <p className="text-xs text-muted-foreground">
          What {activeAgent?.name ?? "the active agent"}&apos;s chats use.
        </p>
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <ModelPicker
          value={value}
          onSelect={(selection) =>
            save.mutate({ providerName: selection.provider, model: selection.model })
          }
          disabled={save.isPending || !agentId}
          ariaLabel={`Model for ${activeAgent?.name ?? "the active agent"}`}
        />
        {/* Status line under the control: the trigger already names the pair
            and its route, so this only states where the selection comes
            from. Held until the active agent resolves so a loading frame
            can't claim a source. */}
        {!activeAgent ? null : isDefaultAgent ? (
          <p className="text-xs text-muted-foreground">This is the default model</p>
        ) : isFollowing ? (
          <p className="text-xs text-muted-foreground">Using the default model</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Pinned for this agent
            {defaultPair ? (
              <>
                {" "}·{" "}
                <button
                  type="button"
                  disabled={save.isPending}
                  onClick={() =>
                    // Copy the CURRENT default as a new pin — the agent stays
                    // a snapshot, unsynced from future default changes.
                    save.mutate({ providerName: defaultPair.provider, model: defaultPair.model })
                  }
                  className="font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-50"
                >
                  Use default model
                </button>
              </>
            ) : null}
          </p>
        )}
      </div>
    </section>
  );
}
