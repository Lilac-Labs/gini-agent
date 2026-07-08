"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { ProviderConfig } from "@runtime/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from "@/components/ui/dialog";
import { DocReference } from "@/components/DocReference";
import { providerIcon } from "@/components/provider-logos";
import { api } from "@/lib/api";
import { displayProviderName, type ProviderCatalogItem } from "@/lib/providers";
import { EditProviderDialog } from "./EditProviderDialog";

// Providers whose credentials gini stores locally and can therefore scrub from
// this UI: removal deletes the secrets.env line(s) + env vars, reversibly (the
// user can add the provider back). Bedrock is included — gini now stores its AWS
// access key + secret, so disconnect scrubs both. Codex is owned by the codex
// CLI and local has no key to clear, so neither row exposes the trash button.
// Azure is excluded too: its row only renders while it is the instance provider
// (it has no default endpoint, so an inactive azure config isn't "configured"),
// and the trash button is disabled for that row — a permanently-dead affordance.
// Azure is managed by re-add via Add Provider; key cleanup is the CLI `gini
// provider` path.
const REMOVABLE_PROVIDERS = new Set(["openai", "openrouter", "deepseek", "anthropic", "bedrock"]);

// Provider rows shown on the Settings page, in display order. Echo is
// dev-only and never configured, so it can't appear.
const SELECTABLE_PROVIDERS = ["codex", "openai", "anthropic", "bedrock", "deepseek", "openrouter", "azure", "local"] as const;

// Friendly labels for how each provider authenticates; the brand icons live
// in the shared PROVIDER_ICONS map (provider-logos.tsx).
const PROVIDER_AUTH_LABEL: Record<string, string> = {
  codex: "OAuth",
  openai: "API key",
  anthropic: "API key",
  bedrock: "AWS",
  deepseek: "API key",
  openrouter: "API key",
  azure: "API key",
  local: "Local"
};

interface SetProviderResult {
  ok: boolean;
  error?: string;
}

// Connected-provider rows: credential management only (edit transport
// config, disconnect, add). Model selection is model-first — the Default
// model and Agent model pickers above the list own it (ADR
// model-first-selection.md), so the rows carry no selection affordance.
export function ProviderCard({
  catalog,
  activeProviderName,
  activeProviderModel,
  activeProviderAwsRegion,
  activeProvider,
  defaultModelProviderName
}: {
  catalog: ProviderCatalogItem[];
  // The INSTANCE provider (config.provider) — the fallback for
  // override-less agents and the embeddings/reranker anchor. Used to mark
  // which row's removal would strand the instance, and to prefill Edit.
  activeProviderName?: string;
  activeProviderModel?: string;
  // Instance bedrock provider's region — threaded into the Edit dialog so it
  // opens pre-filled.
  activeProviderAwsRegion?: string;
  // Full persisted config for the instance provider (from /status). Carries
  // the transport fields the static catalog doesn't — baseUrl + Azure
  // routing — so the Edit dialog can prefill them.
  activeProvider?: ProviderConfig;
  // The provider the DEFAULT MODEL rides (the default agent's pair). Can
  // diverge from config.provider when a /setup/provider write (add-provider,
  // Edit dialog, CLI) moved the instance underneath it — the removal gate
  // must cover both or the default model's provider becomes removable.
  defaultModelProviderName?: string;
}) {
  // Keep needs_reauth rows even when unconfigured: bedrock/anthropic flip
  // `configured` to false the moment their credentials VANISH (env scrubbed,
  // launchd restart without the shell env), which is precisely a needs-re-auth
  // state — dropping the row would hide the amber guidance for the exact failure
  // it explains. Unconfigured rows without a failure record stay hidden.
  const rows = SELECTABLE_PROVIDERS
    .map((name) => catalog.find((c) => c.name === name))
    .filter((c): c is ProviderCatalogItem =>
      c !== undefined && (c.configured === true || c.authStatus === "needs_reauth"));

  // Row whose Edit pencil opened the inline dialog. Null when closed.
  const [editingRow, setEditingRow] = useState<ProviderCatalogItem | null>(null);
  // Row whose Trash button is pending confirmation. Null when no
  // confirmation is open. Removal scrubs the env var + secrets.env line,
  // so the confirmation is mandatory.
  const [removingRow, setRemovingRow] = useState<ProviderCatalogItem | null>(null);
  const queryClient = useQueryClient();

  const removeProvider = useMutation({
    mutationFn: async (name: string): Promise<SetProviderResult> =>
      api<SetProviderResult>("/setup/provider/remove", {
        method: "POST",
        body: JSON.stringify({ provider: name })
      }),
    onSuccess: async (result, name) => {
      if (!result.ok) {
        toast.error(result.error ?? `Failed to remove ${name}.`);
        return;
      }
      toast.success(`${name} disconnected.`);
      setRemovingRow(null);
      // Refetch synchronously so the row drops from the list before the
      // confirmation dialog closes — visible state matches the toast.
      queryClient.invalidateQueries({ queryKey: ["status"] });
      await queryClient.refetchQueries({ queryKey: ["providers"] });
    },
    onError: (error: Error) => toast.error(error.message)
  });

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Model providers</h2>
          <p className="text-xs text-muted-foreground">
            Manage connected providers and their credentials, or connect a new one.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/settings/add-provider">
            <PlusIcon className="size-4" />
            Add provider
          </Link>
        </Button>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-background p-10 text-center">
          <p className="text-sm font-medium text-foreground">No providers connected yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground">
            Add a provider to start chatting. Gini stores keys locally in
            <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">~/.gini/secrets.env</code>
            and never proxies them anywhere except the provider you pick.
          </p>
        </div>
      ) : null}

      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const isInstanceProvider = activeProviderName === row.name;
          const Icon = providerIcon(row.name);
          const authLabel = PROVIDER_AUTH_LABEL[row.name] ?? row.auth;
          const model = isInstanceProvider
            ? (activeProviderModel ?? row.models[0] ?? "")
            : (row.models[0] ?? "");
          // Persistent needs-reauth state (issue #233): the runtime recorded a
          // provider auth failure that nothing has cleared yet. The row swaps
          // the green "Connected" for an amber "Needs re-authentication" with
          // the redacted provider error and a CTA routed the same way as the
          // chat re-auth note (BlockSystemNote): "docs" opens the in-app doc
          // slide-over, "settings" opens the key-edit dialog that already
          // lives on this row, "aws" opens that same edit dialog to re-enter the
          // AWS access key + secret. The fallbacks mirror BlockSystemNote so a
          // payload missing the routing fields never renders a broken CTA.
          const needsReauth = row.authStatus === "needs_reauth";
          const reauthKind = row.reauth?.reauthKind ?? "settings";
          const reauthUrl = row.reauth?.reauthUrl ?? "/settings";

          return (
            <li
              key={row.id}
              className={`flex items-center gap-4 rounded-2xl border p-5 ${
                needsReauth ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card"
              }`}
            >
              <span className="flex size-[42px] items-center justify-center rounded-[11px] bg-muted">
                <Icon className="size-5 text-foreground" />
              </span>
              <div className="flex-1 space-y-1.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-[15px] font-semibold text-foreground">{displayProviderName(row)}</span>
                  <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                    {authLabel}
                  </span>
                </div>
                <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
                  {needsReauth ? (
                    <>
                      <span className="size-2 rounded-full bg-amber-500" aria-hidden />
                      <span className="font-medium text-amber-600 dark:text-amber-500">
                        Needs re-authentication
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="size-2 rounded-full bg-emerald-400" aria-hidden />
                      <span>Connected</span>
                    </>
                  )}
                  <span className="text-muted-foreground">·</span>
                  <span className="font-mono">{model}</span>
                </div>
                {needsReauth && row.reauth?.detail ? (
                  <p className="text-[11px] italic text-muted-foreground">{row.reauth.detail}</p>
                ) : null}
                {needsReauth ? (
                  reauthKind === "docs" ? (
                    <DocReference url={reauthUrl}>
                      <Button size="sm" variant="outline" className="mt-1.5">
                        How to re-authenticate {displayProviderName(row)}
                      </Button>
                    </DocReference>
                  ) : reauthKind === "aws" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1.5"
                      onClick={() => setEditingRow(row)}
                    >
                      Update {displayProviderName(row)} credentials
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1.5"
                      onClick={() => setEditingRow(row)}
                    >
                      Update {displayProviderName(row)} key
                    </Button>
                  )
                ) : null}
                {row.setupDocUrl ? (
                  <DocReference url={row.setupDocUrl}>
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      Setup guide
                    </button>
                  </DocReference>
                ) : null}
              </div>
              {/*
                Codex authenticates via codex login → ~/.codex/auth.json,
                so there's no key or model to edit from this UI and nothing
                to "remove" without breaking the user's shell auth. Hide
                both row-level actions for codex; the Verify flow on the
                Add Provider page and the needs-reauth docs CTA above are
                the only places codex re-auth lives.
              */}
              {row.name === "codex" ? null : (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={`Edit ${displayProviderName(row)}`}
                    onClick={() => setEditingRow(row)}
                  >
                    <PencilIcon className="size-4 text-muted-foreground" />
                  </Button>
                  {REMOVABLE_PROVIDERS.has(row.name) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={`Remove ${displayProviderName(row)}`}
                      // Block removal of the provider backing the instance
                      // fallback OR the default model — point the default
                      // model somewhere else first, then delete. Avoids
                      // surprise fallbacks mid-conversation.
                      disabled={isInstanceProvider || row.name === defaultModelProviderName}
                      title={
                        isInstanceProvider || row.name === defaultModelProviderName
                          ? "Switch the default model off this provider before removing it."
                          : undefined
                      }
                      onClick={() => setRemovingRow(row)}
                    >
                      <Trash2Icon className="size-4 text-muted-foreground" />
                    </Button>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog
        open={Boolean(removingRow)}
        onOpenChange={(open) => {
          if (!open && !removeProvider.isPending) setRemovingRow(null);
        }}
      >
        <DialogContent className="gap-5 border-border bg-card p-7 sm:max-w-md">
          <DialogTitle className="text-base font-bold text-foreground">
            Remove {removingRow ? displayProviderName(removingRow) : "provider"}?
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            You can reconnect anytime.
          </DialogDescription>
          <div className="flex items-center justify-end gap-2.5 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemovingRow(null)}
              disabled={removeProvider.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => removingRow && removeProvider.mutate(removingRow.name)}
              disabled={!removingRow || removeProvider.isPending}
            >
              {removeProvider.isPending ? "Removing…" : "Remove"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {editingRow ? (
        <EditProviderDialog
          row={editingRow}
          authLabel={PROVIDER_AUTH_LABEL[editingRow.name] ?? editingRow.auth}
          icon={providerIcon(editingRow.name)}
          currentModel={editingRow.name === activeProviderName ? activeProviderModel : undefined}
          // Instance bedrock region — prefilled only when editing that row.
          currentAwsRegion={editingRow.name === activeProviderName ? activeProviderAwsRegion : undefined}
          // Prefill transport fields only when editing the instance provider's
          // row — the persisted config from /status describes it alone.
          activeConfig={editingRow.name === activeProviderName ? activeProvider : undefined}
          open={Boolean(editingRow)}
          onOpenChange={(open) => {
            if (!open) setEditingRow(null);
          }}
        />
      ) : null}
    </section>
  );
}
