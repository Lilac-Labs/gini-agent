"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, Search, SearchX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { useConnectors, useGoogleAccounts, useInvalidate, useProviders, type ProviderDescriptor } from "@/lib/queries";
import { AddConnectorDialog, type CreateConnectorBody } from "@/components/AddConnectorDialog";
import { ManualCredentialDialog } from "@/components/ManualCredentialDialog";
import { GoogleAccountsCard, GoogleLogo } from "./_components/GoogleAccountsCard";
import { BRAND_LOGOS } from "./_components/brand-logos";
import {
  GOOGLE_PROVIDER_ID,
  buildTiles,
  configuredRecord,
  filterTiles,
  tileCounts,
  type IntegrationTile,
  type TileFilter
} from "./_lib";
import type { ConnectorRecord } from "@runtime/types";

type DetectionReport = {
  considered: number;
  created: Array<{ id: string; provider: string; name: string }>;
  skipped: Array<{ provider: string; reason: string }>;
};

// State for the shared AddConnectorDialog. "create" is the Add MCP server
// header action — the type-driven dialog locked to the custom/`generic`
// credential (api key + optional MCP URL). "rotate" replaces the secrets on
// an existing record from the manage dialog; connectorId carries the record
// so submit can PATCH it.
interface ConnectorDialogState {
  open: boolean;
  provider: string;
  suggestedName: string;
  mode: "create" | "rotate";
  connectorId?: string;
}

const CLOSED_DIALOG: ConnectorDialogState = { open: false, provider: "", suggestedName: "", mode: "create" };

const CHIP_LABELS: Record<TileFilter, string> = { all: "All", connected: "Connected", available: "Available" };

export default function IntegrationsPage() {
  const connectors = useConnectors();
  const providers = useProviders();
  // Machine-global registry — exists even with no google-oauth-desktop
  // connector record, so the Google tile count and drilldown render on a
  // registry-only machine.
  const googleAccounts = useGoogleAccounts();
  const invalidate = useInvalidate();

  // The Google drilldown is in-page view state (matching the design), not a
  // nested route.
  const [view, setView] = useState<"list" | "google">("list");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TileFilter>("all");
  const [dialog, setDialog] = useState<ConnectorDialogState>(CLOSED_DIALOG);
  const [manualProvider, setManualProvider] = useState<ProviderDescriptor | null>(null);
  // Provider id the manage dialog is open for. The record is derived live
  // from the connectors query so a health check updates the dialog in place.
  const [managing, setManaging] = useState<string | null>(null);

  const detect = useMutation({
    mutationFn: () => api<DetectionReport>("/connectors/detect", { method: "POST" }),
    onSuccess: (result) => {
      const created = result.created.length;
      toast.success(created === 0 ? "Detection ran — no new connectors." : `Detected ${created} connector${created === 1 ? "" : "s"}.`);
      invalidate(["connectors", "skills", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const create = useMutation({
    mutationFn: (body: CreateConnectorBody) =>
      api<ConnectorRecord>("/connectors", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (created) => {
      toast.success(`Added ${created.name}`);
      // The runtime probes on create now, so the response already carries
      // settled health — no compensating POST /health needed.
      invalidate(["connectors", "events", "skills"]);
      setDialog(CLOSED_DIALOG);
      setManualProvider(null);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const rotate = useMutation({
    mutationFn: ({ id, body }: { id: string; body: CreateConnectorBody }) =>
      api<ConnectorRecord>(`/connectors/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (updated) => {
      toast.success(`Rotated ${updated.name}`);
      // The runtime probes on secret rotation now, so the response already
      // carries settled health — no compensating POST /health needed.
      invalidate(["connectors", "events", "skills"]);
      setDialog(CLOSED_DIALOG);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api<{ id: string; tombstoned?: boolean }>(`/connectors/${id}`, { method: "DELETE" }),
    onSuccess: (result) => {
      toast.success(result.tombstoned ? "Disconnected (kept as tombstone)" : "Connector removed");
      invalidate(["connectors", "events", "skills"]);
      setManaging(null);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const checkHealth = useMutation({
    mutationFn: (id: string) => api<ConnectorRecord>(`/connectors/${id}/health`, { method: "POST" }),
    onSuccess: (record) => {
      if (record.health === "healthy") toast.success(`${record.name} is healthy`);
      else toast.error(record.message || `${record.name}: ${record.health}`);
      invalidate(["connectors", "skills"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const googleAccountsList = googleAccounts.data ?? [];
  const googleSignedInCount = googleAccountsList.filter((a) => a.signedIn).length;
  const tiles = buildTiles(providers.data ?? [], connectors.data ?? [], googleAccountsList.length, googleSignedInCount);
  const counts = tileCounts(tiles);
  const visible = filterTiles(tiles, filter, search);

  const managedRecord = managing ? configuredRecord(connectors.data ?? [], managing) : undefined;
  const managedProvider = managing ? (providers.data ?? []).find((p) => p.id === managing) : undefined;

  const openTile = (tile: IntegrationTile) => {
    const p = tile.provider;
    if (p.id === GOOGLE_PROVIDER_ID) {
      setView("google");
      return;
    }
    if (tile.connected) {
      // Externally-satisfied providers with no record have nothing to
      // manage — the tile just shows the provisioned state.
      if (configuredRecord(connectors.data ?? [], p.id)) setManaging(p.id);
      return;
    }
    // Available → the provider's connect flow: a declared credential template
    // gets the focused paste-the-secrets dialog; detectable CLIs (claude-code,
    // codex) connect by running detection; field-less providers (demo) are
    // created directly.
    if (p.credentialTemplate) {
      setManualProvider(p);
      return;
    }
    if (p.hasDetect) {
      detect.mutate();
      return;
    }
    create.mutate({ provider: p.id, name: p.label, secrets: {} });
  };

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect the tools you use and let Gini perform tasks across them."
        actions={
          <>
            <Button size="sm" variant="outline" disabled={detect.isPending} onClick={() => detect.mutate()}>
              {detect.isPending ? "Detecting…" : "Refresh detection"}
            </Button>
            <Button size="sm" onClick={() => setDialog({ ...CLOSED_DIALOG, open: true, provider: "generic" })}>
              Add MCP server
            </Button>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[1080px]">
          {view === "google" ? (
            <div className="flex flex-col gap-3">
              <Button variant="outline" size="sm" className="self-start" onClick={() => setView("list")}>
                <ChevronLeft className="size-4" />
                All integrations
              </Button>
              <div className="mt-1.5 flex items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] border border-border bg-white">
                  <GoogleLogo className="size-6" />
                </span>
                <div>
                  <div className="text-[17px] font-bold">Google</div>
                  <div className="text-[13px] text-muted-foreground">
                    Connect your account to enable email and calendar features.
                  </div>
                </div>
              </div>
              <GoogleAccountsCard accounts={googleAccounts.data ?? []} />
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-4 top-1/2 size-[17px] -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search integrations"
                  className="h-[46px] rounded-xl bg-card pl-11"
                />
              </div>
              <div className="mt-4 flex gap-2.5">
                {(Object.keys(CHIP_LABELS) as TileFilter[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setFilter(key)}
                    className={`inline-flex h-[34px] items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors ${
                      filter === key
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-card text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {CHIP_LABELS[key]}
                    <span className={`font-semibold ${filter === key ? "opacity-80" : "opacity-60"}`}>
                      {counts[key]}
                    </span>
                  </button>
                ))}
              </div>
              {visible.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2.5 px-5 py-16 text-center">
                  <SearchX className="size-[26px] text-muted-foreground" />
                  <div className="text-[15px] font-semibold">No integrations found</div>
                  <div className="text-sm text-muted-foreground">Try a different search or filter.</div>
                </div>
              ) : (
                <div className="mt-[22px] grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {visible.map((tile) => {
                    // Official brand mark on the white tile (white in dark
                    // mode too, matching the drilldown's Google mark); the
                    // colored monogram is the fallback for providers with no
                    // sourceable mark.
                    const Logo = BRAND_LOGOS[tile.provider.id];
                    return (
                      <button
                        key={tile.provider.id}
                        type="button"
                        onClick={() => openTile(tile)}
                        className="flex w-full items-center gap-[13px] rounded-xl border border-border bg-card px-[15px] py-3.5 text-left transition-colors hover:border-foreground/20 hover:bg-muted"
                      >
                        {Logo ? (
                          <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] border border-border bg-white">
                            <Logo className="size-6" />
                          </span>
                        ) : (
                          <span
                            className="flex size-10 shrink-0 items-center justify-center rounded-[11px] text-[17px] font-bold text-white"
                            style={{ backgroundColor: tile.color }}
                          >
                            {tile.initial}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14.5px] font-semibold">{tile.label}</span>
                          {tile.state === "connected" ? (
                            <span className="mt-0.5 flex items-center gap-1.5">
                              <span className="size-[7px] shrink-0 rounded-full bg-emerald-500" />
                              <span className="text-[12.5px] font-medium text-emerald-600">{tile.status}</span>
                            </span>
                          ) : tile.state === "needs-attention" ? (
                            <span className="mt-0.5 flex items-center gap-1.5">
                              <span className="size-[7px] shrink-0 rounded-full bg-amber-500" />
                              <span className="text-[12.5px] font-medium text-amber-600">{tile.status}</span>
                            </span>
                          ) : (
                            <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                              {tile.provider.description}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Connected (non-Google) tile → manage the provider's record. */}
      <Dialog open={Boolean(managing && managedRecord)} onOpenChange={(open) => { if (!open) setManaging(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{managedProvider?.label ?? managing}</DialogTitle>
            <DialogDescription>Manage this connection&apos;s credential and health.</DialogDescription>
          </DialogHeader>
          {managedRecord ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs">{managedRecord.name}</span>
                <Badge
                  variant="outline"
                  className={`text-[10px] ${
                    managedRecord.health === "healthy"
                      ? "text-emerald-600"
                      : managedRecord.health === "unhealthy"
                        ? "text-amber-600"
                        : "text-muted-foreground"
                  }`}
                >
                  {managedRecord.health}
                </Badge>
              </div>
              {managedRecord.message ? (
                <p className="text-xs text-muted-foreground">{managedRecord.message}</p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              disabled={checkHealth.isPending || !managedRecord}
              onClick={() => managedRecord && checkHealth.mutate(managedRecord.id)}
            >
              {checkHealth.isPending ? "Checking…" : "Check health"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!managedRecord}
              onClick={() =>
                managedRecord &&
                setDialog({
                  open: true,
                  provider: managedRecord.provider,
                  suggestedName: managedRecord.name,
                  mode: "rotate",
                  connectorId: managedRecord.id
                })
              }
            >
              Rotate
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={disconnect.isPending || !managedRecord}
              onClick={() => {
                if (!managedRecord) return;
                const message = `Disconnect ${managedRecord.name}?\nSkills that require this credential will deactivate.`;
                if (confirm(message)) disconnect.mutate(managedRecord.id);
              }}
            >
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddConnectorDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((prev) => (open ? prev : CLOSED_DIALOG))}
        onSubmit={(body) =>
          dialog.mode === "rotate" && dialog.connectorId
            ? rotate.mutate({ id: dialog.connectorId, body })
            : create.mutate(body)
        }
        pending={dialog.mode === "rotate" ? rotate.isPending : create.isPending}
        providers={providers.data ?? []}
        defaultProvider={dialog.provider || undefined}
        defaultName={dialog.suggestedName}
        lockProvider
        mode={dialog.mode}
        // Create mode here is only ever the "Add MCP server" header action, so
        // frame the dialog after it. Rotate mode renders its own title/copy
        // and ignores these.
        title="Add MCP server"
        description="Register a custom MCP server. The API key is stored encrypted and sent as a bearer token to the server URL."
        namePlaceholder="MCP_SERVER_API_KEY"
        secretPlaceholder="paste the server's API key"
      />

      <ManualCredentialDialog
        open={manualProvider !== null}
        onOpenChange={(open) => { if (!open) setManualProvider(null); }}
        provider={manualProvider}
        onSubmit={(body) => create.mutate(body)}
        pending={create.isPending}
      />
    </>
  );
}
