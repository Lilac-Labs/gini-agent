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

export type TileState = "connected" | "needs-attention" | "available";

export interface IntegrationTile {
  provider: ProviderDescriptor;
  // Displayed tile name: the override label when one exists, else the
  // provider descriptor label. Search matches against this.
  label: string;
  color: string;
  initial: string;
  connected: boolean;
  // Three-state: "connected" (green, usable), "needs-attention" (configured
  // but not usable — stays in the Connected section), "available" (not
  // configured at all). The tile chip/section filter treats needs-attention
  // as connected (the user DID connect it; it needs fixing, not re-adding).
  state: TileState;
  // Status line: "Connected" / "2 accounts connected" / "Needs attention" /
  // warning message / null (available tiles show the description instead).
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
// the "Add MCP server" action). All local integrations remain visible.
// Connected = a configured connector record exists for the provider AND is
// usable, OR its credential is satisfied out-of-band (`externallySatisfied`
// — e.g. a locally managed Google account, which may not have a connector
// record). Configured-but-not-usable is "Needs attention" — stays in the
// Connected chip section (user DID connect it; it needs fixing). The Google
// tile counts the tagged accounts from the machine-global registry in its
// status line; if ALL accounts need reconnection → Needs attention.
export function buildTiles(
  providers: ProviderDescriptor[],
  connectors: ConnectorRecord[],
  googleAccountCount: number,
  googleSignedInCount?: number
): IntegrationTile[] {
  return providers
    .filter((p) => p.id !== "generic")
    .map((p) => {
      const override = TILE_OVERRIDES[p.id];
      const label = override?.label ?? p.label;
      const record = configuredRecord(connectors, p.id);
      // Derive the three-state for this tile.
      let state: TileState;
      let status: string | null;
      if (p.id === GOOGLE_PROVIDER_ID) {
        // Google: externallySatisfied OR configured record constitutes
        // "has been connected". Usability additionally requires at least
        // one signed-in account.
        const hasConnection = Boolean(record) || Boolean(p.externallySatisfied);
        if (!hasConnection) {
          state = "available";
          status = null;
        } else if (googleAccountCount > 0 && (googleSignedInCount ?? googleAccountCount) > 0) {
          state = "connected";
          const signedIn = googleSignedInCount ?? googleAccountCount;
          const needsReconnect = googleAccountCount - signedIn;
          status = needsReconnect > 0
            ? `${signedIn} connected, ${needsReconnect} need${needsReconnect === 1 ? "s" : ""} reconnection`
            : `${googleAccountCount} account${googleAccountCount === 1 ? "" : "s"} connected`;
        } else if (googleAccountCount > 0) {
          // All accounts need reconnection.
          state = "needs-attention";
          status = "Accounts need reconnection";
        } else {
          // Connected but zero accounts — treat as needs-attention since
          // the credential isn't yielding anything usable.
          state = hasConnection && record?.usable ? "connected" : "needs-attention";
          status = state === "connected" ? "Connected" : "Needs attention";
        }
      } else if (record) {
        // Non-Google: a configured record exists.
        if (record.usable) {
          state = "connected";
          status = "Connected";
        } else {
          state = "needs-attention";
          status = record.message || (record.health === "unknown" ? "Checking…" : "Validation failed");
        }
      } else if (p.externallySatisfied) {
        state = "connected";
        status = "Connected";
      } else {
        state = "available";
        status = null;
      }
      const connected = state !== "available";
      return {
        provider: p,
        label,
        color: override?.color ?? FALLBACK_TILE_COLOR,
        initial: (label.charAt(0) || "?").toUpperCase(),
        connected,
        state,
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
