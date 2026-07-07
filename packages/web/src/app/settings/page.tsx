"use client";

import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { useInvalidate, useStatus } from "@/lib/queries";
import { DefaultModelControl } from "./_components/DefaultModelControl";
import { ProviderCard } from "./_components/ProviderCard";
import type { ProviderCatalogItem } from "@/lib/providers";
import type { AgentRow } from "@/lib/view-types";
import { ToolsetsCard, type ToolsetRow } from "./_components/ToolsetsCard";
import { McpCard, type McpRow } from "./_components/McpCard";
import { MessagingCard, type MessagingRow } from "./_components/MessagingCard";
import { BrowserSettingsCard } from "./_components/BrowserSettingsCard";

export default function SettingsPage() {
  const invalidate = useInvalidate();
  const status = useStatus();
  const catalog = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<ProviderCatalogItem[]>("/providers/catalog"),
    refetchInterval: 60_000
  });
  // The default agent's provider — the route the default model actually
  // rides. Threaded into ProviderCard so its removal gate covers it even
  // when a /setup/provider write has moved config.provider elsewhere.
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ agents: AgentRow[]; activeAgentId?: string }>("/agents")
  });
  const defaultAgent =
    agents.data?.agents.find((agent) => agent.id === "agent_default") ??
    agents.data?.agents.find((agent) => agent.id === "profile_default");
  const toolsets = useQuery({
    queryKey: ["toolsets"],
    queryFn: () => api<{ toolsets: ToolsetRow[] }>("/toolsets")
  });
  const mcp = useQuery({
    queryKey: ["mcp"],
    queryFn: () => api<McpRow[]>("/mcp")
  });
  const messaging = useQuery({
    queryKey: ["messaging"],
    queryFn: () => api<MessagingRow[]>("/messaging")
  });
  const toolsetToggle = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "enable" | "disable" }) =>
      api(`/toolsets/${encodeURIComponent(id)}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => { toast.success(`Toolset ${vars.op}d`); invalidate(["toolsets", "state"]); },
    onError: (error: Error) => toast.error(error.message)
  });

  const mcpHealth = useMutation({
    mutationFn: (id: string) => api(`/mcp/${encodeURIComponent(id)}/health`, { method: "POST" }),
    onSuccess: () => { toast.success("MCP server checked"); invalidate(["mcp", "events"]); },
    onError: (error: Error) => toast.error(error.message)
  });

  const mcpDisable = useMutation({
    mutationFn: (id: string) => api(`/mcp/${encodeURIComponent(id)}/disable`, { method: "POST" }),
    onSuccess: () => { toast.success("MCP server disabled"); invalidate(["mcp", "state"]); },
    onError: (error: Error) => toast.error(error.message)
  });

  const messagingHealth = useMutation({
    mutationFn: (id: string) => api(`/messaging/${encodeURIComponent(id)}/health`, { method: "POST" }),
    onSuccess: () => { toast.success("Bridge checked"); invalidate(["messaging", "events"]); },
    onError: (error: Error) => toast.error(error.message)
  });

  const messagingRemove = useMutation({
    mutationFn: (id: string) => api(`/messaging/${encodeURIComponent(id)}/remove`, { method: "POST" }),
    onSuccess: () => { toast.success("Bridge removed"); invalidate(["messaging", "state", "events"]); },
    onError: (error: Error) => toast.error(error.message)
  });

  // The INSTANCE provider (config.provider) — the transport behind the
  // default model and the fallback for override-less agents. The provider
  // rows use it to gate removal and prefill the Edit dialog; model
  // selection itself lives in the Default model picker above the rows.
  const activeProviderName = status.data?.provider?.provider?.name;
  const activeProviderModel = status.data?.provider?.provider?.model;
  const activeProviderAwsRegion = status.data?.provider?.provider?.awsRegion;
  // The full persisted config for the instance provider — carries the
  // transport fields (baseUrl + Azure routing) the static catalog doesn't,
  // so the Edit dialog can prefill them.
  const activeProvider = status.data?.provider?.provider;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Providers, browser, toolsets, integrations"
        actions={
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
            <Link href="/overview">Overview</Link>
          </Button>
        }
      />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        <DefaultModelControl />

        <ProviderCard
          catalog={catalog.data ?? []}
          activeProviderName={activeProviderName}
          activeProviderModel={activeProviderModel}
          activeProviderAwsRegion={activeProviderAwsRegion}
          activeProvider={activeProvider}
          defaultModelProviderName={defaultAgent?.providerName}
        />

        <BrowserSettingsCard />

        <ToolsetsCard
          toolsets={toolsets.data?.toolsets ?? []}
          pending={toolsetToggle.isPending}
          onToggle={(id, op) => toolsetToggle.mutate({ id, op })}
        />

        <McpCard
          servers={mcp.data ?? []}
          healthPending={mcpHealth.isPending}
          disablePending={mcpDisable.isPending}
          onHealth={(id) => mcpHealth.mutate(id)}
          onDisable={(id) => mcpDisable.mutate(id)}
        />

        <MessagingCard
          bridges={messaging.data ?? []}
          healthPending={messagingHealth.isPending}
          removePending={messagingRemove.isPending}
          onHealth={(id) => messagingHealth.mutate(id)}
          onRemove={(id) => messagingRemove.mutate(id)}
        />
      </div>
    </>
  );
}
