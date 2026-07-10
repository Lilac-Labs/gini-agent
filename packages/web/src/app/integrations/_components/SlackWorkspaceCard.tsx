"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInvalidate } from "@/lib/queries";
import { api } from "@/lib/api";
import { SlackConnectDialog } from "@/components/SlackConnectDialog";
import { SlackLogo } from "./brand-logos";
import type { SlackBridgeLike } from "../_lib";

// The Slack drilldown on the Integrations page, mirroring GoogleAccountsCard:
// a count line + "Connect workspace" action, then one row per slack messaging
// bridge (workspace name, teamId/slackUserId meta, connected/needs-attention
// status). Disconnect fully removes the bridge (POST /api/messaging/<id>/remove
// — disable is the softer state the Settings Messaging card owns). `mode` is the
// resolved Google auth mode: hosted (edge) runs the /auth/slack/install OAuth
// flow; everywhere else Connect opens the BYO Socket-Mode dialog inline.
export function SlackWorkspaceCard({
  bridges,
  mode
}: {
  bridges: SlackBridgeLike[];
  mode?: "edge" | "loopback";
}) {
  const invalidate = useInvalidate();
  const [connectOpen, setConnectOpen] = useState(false);

  const remove = useMutation({
    mutationFn: (id: string) => api<{ id: string }>(`/messaging/${id}/remove`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Workspace disconnected");
      invalidate(["messaging"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const slack = bridges.filter((b) => b.kind === "slack");

  const connect = () => {
    if (mode === "edge") {
      window.location.assign(`/auth/slack/install?returnTo=${encodeURIComponent("/integrations")}`);
    } else {
      // Local / self-host: open the BYO Socket-Mode connect dialog inline on
      // this page — no hop to Settings. On success the messaging query is
      // invalidated, so the new bridge row appears in the table below.
      setConnectOpen(true);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          {slack.length} workspace{slack.length === 1 ? "" : "s"} connected
        </p>
        <Button variant="outline" size="sm" onClick={connect}>
          <PlusIcon className="size-3.5" />
          Connect workspace
        </Button>
      </div>

      {slack.length === 0 ? (
        <p className="text-sm text-muted-foreground">No workspace connected yet.</p>
      ) : (
        slack.map((bridge) => {
          const teamName = bridge.metadata?.teamName?.trim();
          const workspaceName = teamName || bridge.name || bridge.id;
          const configured = bridge.status === "configured";
          const meta = [
            bridge.metadata?.teamId ? `Team ${bridge.metadata.teamId}` : null,
            bridge.metadata?.slackUserId ? `User ${bridge.metadata.slackUserId}` : null
          ].filter(Boolean);
          return (
            <div key={bridge.id} className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-center gap-3.5 px-5 py-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-white">
                  <SlackLogo className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-bold">{workspaceName}</div>
                  {meta.length > 0 ? (
                    <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{meta.join(" · ")}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  {configured ? (
                    <span className="flex items-center gap-1.5 text-[13px] font-semibold text-emerald-600">
                      <span className="size-[7px] shrink-0 rounded-full bg-emerald-500" />
                      Connected
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-600">
                      <span className="size-[7px] shrink-0 rounded-full bg-amber-500" />
                      {bridge.message?.trim() || "Needs attention"}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Disconnect ${workspaceName}`}
                    disabled={remove.isPending}
                    onClick={() => {
                      const message = `Disconnect ${workspaceName}?\nGini will stop responding to DMs in this workspace.`;
                      if (confirm(message)) remove.mutate(bridge.id);
                    }}
                  >
                    {remove.isPending ? "Disconnecting…" : "Disconnect"}
                  </Button>
                </div>
              </div>
            </div>
          );
        })
      )}

      <SlackConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}
