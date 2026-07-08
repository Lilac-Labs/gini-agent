// Pure-JS tests (no React/DOM) for the Integrations directory logic: which
// providers become tiles, when a tile counts as connected (configured record
// vs the hosted externallySatisfied path), the Google account-count status
// line, and chip/search filtering.

import { describe, expect, test } from "bun:test";
import type { ConnectorRecord } from "@runtime/types";
import type { ProviderDescriptor } from "@/lib/queries";
import { GOOGLE_PROVIDER_ID, buildTiles, configuredRecord, filterTiles, tileCounts } from "./_lib";

function provider(overrides: Partial<ProviderDescriptor>): ProviderDescriptor {
  return {
    id: "linear",
    label: "Linear",
    description: "Query and update Linear issues.",
    fields: [],
    hasProbe: true,
    hasDetect: false,
    ...overrides
  };
}

function connector(overrides: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: "conn_test",
    instance: "dev",
    name: "LINEAR_API_KEY",
    provider: "linear",
    status: "configured",
    scopes: [],
    secretRefs: [],
    createdAt: "",
    updatedAt: "",
    health: "healthy",
    ...overrides
  };
}

describe("buildTiles", () => {
  test("excludes the generic provider (surfaced as the Add MCP server action)", () => {
    const tiles = buildTiles([provider({ id: "generic", label: "Generic" }), provider({})], [], 0);
    expect(tiles.map((t) => t.provider.id)).toEqual(["linear"]);
  });

  test("configured record → connected with 'Connected' status", () => {
    const [tile] = buildTiles([provider({})], [connector({})], 0);
    expect(tile!.connected).toBe(true);
    expect(tile!.status).toBe("Connected");
  });

  test("non-configured record does not connect the tile", () => {
    const [tile] = buildTiles([provider({})], [connector({ status: "disabled" })], 0);
    expect(tile!.connected).toBe(false);
    expect(tile!.status).toBeNull();
  });

  test("externallySatisfied provider is connected with no record (hosted Google)", () => {
    const [tile] = buildTiles([provider({ externallySatisfied: true })], [], 0);
    expect(tile!.connected).toBe(true);
  });

  test("Google status line counts registry accounts", () => {
    const google = provider({ id: GOOGLE_PROVIDER_ID, label: "Google Workspace OAuth", externallySatisfied: true });
    expect(buildTiles([google], [], 1)[0]!.status).toBe("1 account connected");
    expect(buildTiles([google], [], 2)[0]!.status).toBe("2 accounts connected");
  });

  test("brand color for known providers, gray fallback + label initial otherwise", () => {
    const tiles = buildTiles([provider({}), provider({ id: "exa", label: "exa" })], [], 0);
    expect(tiles[0]).toMatchObject({ color: "#5E6AD2", initial: "L" });
    expect(tiles[1]).toMatchObject({ color: "#6B7280", initial: "E" });
  });

  test("Google tile displays the override label, not the descriptor label", () => {
    const google = provider({ id: GOOGLE_PROVIDER_ID, label: "Google Workspace OAuth" });
    const [tile] = buildTiles([google], [], 0);
    expect(tile!.label).toBe("Google");
    // Providers without an override keep the descriptor label.
    expect(buildTiles([provider({})], [], 0)[0]!.label).toBe("Linear");
  });
});

describe("tileCounts / filterTiles", () => {
  const tiles = buildTiles(
    [provider({}), provider({ id: "exa", label: "Exa" }), provider({ id: "bland", label: "Bland AI" })],
    [connector({})],
    0
  );

  test("counts split connected vs available", () => {
    expect(tileCounts(tiles)).toEqual({ all: 3, connected: 1, available: 2 });
  });

  test("chip filters", () => {
    expect(filterTiles(tiles, "connected", "").map((t) => t.provider.id)).toEqual(["linear"]);
    expect(filterTiles(tiles, "available", "").map((t) => t.provider.id)).toEqual(["exa", "bland"]);
    expect(filterTiles(tiles, "all", "")).toHaveLength(3);
  });

  test("search is case-insensitive on the label and composes with the chip", () => {
    expect(filterTiles(tiles, "all", "  bLaNd ").map((t) => t.provider.id)).toEqual(["bland"]);
    expect(filterTiles(tiles, "connected", "exa")).toHaveLength(0);
  });

  test("search matches the displayed label for overridden tiles", () => {
    const google = provider({ id: GOOGLE_PROVIDER_ID, label: "Google Workspace OAuth" });
    const googleTiles = buildTiles([google], [], 0);
    expect(filterTiles(googleTiles, "all", "goog")).toHaveLength(1);
  });

  test("no matches → empty list (empty state)", () => {
    expect(filterTiles(tiles, "all", "zzz")).toHaveLength(0);
  });
});
