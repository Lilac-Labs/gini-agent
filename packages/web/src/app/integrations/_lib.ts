// Pure directory logic for the Integrations page. Extracted from page.tsx so
// tile derivation and filtering can be unit-tested without the client
// component (same pattern as skills/_activation.ts).

import type { ConnectorRecord } from "@runtime/types";
import type { ProviderDescriptor } from "@/lib/queries";

export const GOOGLE_PROVIDER_ID = "google-oauth-desktop";

// Per-provider tile overrides, from the design's tile palette: brand color
// and (optionally) a display label replacing the provider descriptor label —
// the google-oauth-desktop descriptor says "Google Workspace OAuth" but the
// tile reads "Google", matching the drilldown header. Providers without an
// entry fall back to gray + the descriptor label.
const TILE_OVERRIDES: Record<string, { color: string; label?: string }> = {
  [GOOGLE_PROVIDER_ID]: { color: "#4285F4", label: "Google" },
  linear: { color: "#5E6AD2" }
};
const FALLBACK_TILE_COLOR = "#6B7280";

export type TileFilter = "all" | "connected" | "available";

export interface IntegrationTile {
  provider: ProviderDescriptor;
  // Displayed tile name: the override label when one exists, else the
  // provider descriptor label. Search matches against this.
  label: string;
  color: string;
  initial: string;
  connected: boolean;
  // Green status line when connected ("Connected" / "2 accounts connected");
  // null when available (the tile shows the provider description instead).
  status: string | null;
}

// The first configured record for a provider — the one the manage dialog
// operates on.
export function configuredRecord(
  connectors: ConnectorRecord[],
  providerId: string
): ConnectorRecord | undefined {
  return connectors.find((c) => c.provider === providerId && c.status === "configured");
}

// Directory tiles: every registered provider except `generic` (surfaced via
// the "Add MCP server" header action instead). Connected = a configured
// connector record exists for the provider, OR its credential is satisfied
// out-of-band (`externallySatisfied` — e.g. the hosted pre-provisioned Google
// credential, which never has a record). The Google tile counts the tagged
// accounts from the machine-global registry in its status line.
export function buildTiles(
  providers: ProviderDescriptor[],
  connectors: ConnectorRecord[],
  googleAccountCount: number
): IntegrationTile[] {
  return providers
    .filter((p) => p.id !== "generic")
    .map((p) => {
      const override = TILE_OVERRIDES[p.id];
      const label = override?.label ?? p.label;
      const connected = Boolean(configuredRecord(connectors, p.id)) || Boolean(p.externallySatisfied);
      const status = !connected
        ? null
        : p.id === GOOGLE_PROVIDER_ID && googleAccountCount > 0
          ? `${googleAccountCount} account${googleAccountCount === 1 ? "" : "s"} connected`
          : "Connected";
      return {
        provider: p,
        label,
        color: override?.color ?? FALLBACK_TILE_COLOR,
        initial: (label.charAt(0) || "?").toUpperCase(),
        connected,
        status
      };
    });
}

export function tileCounts(tiles: IntegrationTile[]): Record<TileFilter, number> {
  const connected = tiles.filter((t) => t.connected).length;
  return { all: tiles.length, connected, available: tiles.length - connected };
}

// Chip + search filtering. The name match is case-insensitive on the
// displayed tile label.
export function filterTiles(
  tiles: IntegrationTile[],
  filter: TileFilter,
  query: string
): IntegrationTile[] {
  const q = query.trim().toLowerCase();
  return tiles.filter((t) => {
    if (filter === "connected" && !t.connected) return false;
    if (filter === "available" && t.connected) return false;
    return q.length === 0 || t.label.toLowerCase().includes(q);
  });
}
