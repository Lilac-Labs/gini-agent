"use client";

import { useState } from "react";
import { Copy, Check, Eye, EyeOff, Settings2, ShieldCheck, Unplug } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { TunnelQR } from "./TunnelQR";
import type { TunnelState } from "./types";

/**
 * Connected view (popover design Variant01): clean frameless QR, the public
 * URL with a copy button, disclaimers, an edit affordance back to the
 * selection panel, and a Disconnect action.
 *
 * A single `revealed` flag gates both the QR and the URL so the link can't be
 * shoulder-surfed by default: the QR starts blurred behind a "Reveal QR"
 * button and the URL renders as a mask. Revealing is two-way — once shown, the
 * QR carries a "Hide QR code" toggle and the URL doubles as a toggle too — so
 * either control flips both back to hidden. Copy always acts on the real URL.
 */
// Decorative dot mask: a row of uniform filled circles that hides both the URL
// and its length and fills the field width so the copy button sits flush after
// it. The wrapping native button carries the real toggle semantics and
// aria-label; the dot row is purely visual.
const MASK_DOTS = 30;

export function TunnelConnectedPopover({
  state,
  onEdit,
  onDisconnect,
  className
}: {
  state: TunnelState;
  onEdit: () => void;
  onDisconnect: () => void;
  className?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = state.url ?? "";
  const providerName =
    state.providers.find((p) => p.id === state.selectedProvider)?.name ?? "Gini Relay";
  // The 24/7 stability promise only holds where the URL survives a reconnect:
  // the relay (deviceId-keyed subdomain), tailscale (machine name), and a
  // NAMED cloudflare tunnel. ngrok's free tier and cloudflare QUICK tunnels
  // mint a fresh subdomain on every connect — including the restart resume —
  // so the copy must not claim the shared link keeps working.
  const stableUrl =
    state.selectedProvider === "gini-relay" ||
    state.selectedProvider === "tailscale" ||
    (state.selectedProvider === "cloudflare" && !url.includes("trycloudflare.com"));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; ignore
    }
  };

  return (
    <div className={cn("w-full min-w-0 text-popover-foreground", className)}>
      <div className="flex items-center justify-between gap-2 bg-muted/40 px-4 py-3">
        <div className="flex shrink-0 items-center gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />
          <span className="whitespace-nowrap text-sm font-semibold leading-none">
            Tunnel connected
          </span>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          <Badge
            variant="outline"
            className="min-w-0 gap-1.5 border-emerald-500/30 bg-emerald-500/10 font-mono text-[11px] font-semibold text-emerald-400"
          >
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <span className="truncate">{providerName}</span>
          </Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit selection"
            onClick={onEdit}
            className="shrink-0"
          >
            <Settings2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Separator />

      <div className="space-y-4 p-4">
        <div className="grid place-items-center py-2">
          {revealed ? (
            <button
              type="button"
              aria-label="Hide QR code"
              onClick={() => setRevealed(false)}
              className="group relative rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <TunnelQR value={url} className="h-44 w-44" />
              <span
                aria-hidden="true"
                className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-[min(var(--radius-md),10px)] bg-background/70 text-muted-foreground backdrop-blur-sm transition-colors group-hover:text-foreground"
              >
                <EyeOff className="size-3.5" />
              </span>
            </button>
          ) : (
            <button
              type="button"
              aria-label="Reveal QR"
              onClick={() => setRevealed(true)}
              className="group relative block rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <div className="blur-md transition">
                <TunnelQR value={url} className="h-44 w-44" />
              </div>
              <span className="absolute inset-0 grid place-items-center">
                <span className="inline-flex items-center gap-1.5 rounded-[min(var(--radius-md),12px)] bg-primary px-2.5 py-1.5 text-[0.8rem] font-medium text-primary-foreground shadow-sm transition-colors group-hover:bg-primary/90">
                  <Eye className="size-3.5" />
                  Reveal QR
                </span>
              </span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? "Hide public URL" : "Reveal public URL"}
            aria-pressed={revealed}
            className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {revealed ? (
              <span className="block break-all font-mono text-xs text-foreground">{url}</span>
            ) : (
              <span aria-hidden="true" className="flex items-center gap-1 overflow-hidden py-1">
                {Array.from({ length: MASK_DOTS }, (_, i) => (
                  <span key={i} className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                ))}
              </span>
            )}
          </button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Copy public URL"
            onClick={copy}
            className="shrink-0"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Anyone you pair with this link can reach your agent.
          </p>
          <p className="text-xs text-muted-foreground">
            {stableUrl
              ? "It’s a stable link — it stays the same and reconnects automatically after a restart, so you can reach your agent 24/7."
              : "This link changes on every reconnect (including a gateway restart) — re-share the new one, or use a provider with a stable address for 24/7 access."}
          </p>
        </div>

        <Separator />

        <Button variant="destructive" size="sm" className="w-full gap-1.5" onClick={onDisconnect}>
          <Unplug className="h-3.5 w-3.5" />
          Disconnect
        </Button>
      </div>
    </div>
  );
}
