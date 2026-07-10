// Pure-JS tests (no React/DOM) for the Integrations directory logic: which
// providers become tiles, when a tile counts as connected (configured record
// vs the hosted externallySatisfied path), the Google account-count status
// line, and chip/search filtering. After the usability fix: tiles reflect
// the three states (connected / needs-attention / available).

import { describe, expect, test } from "bun:test";
import type { ConnectorRecord } from "@runtime/types";
import type { ProviderDescriptor } from "@/lib/queries";
import {
  GOOGLE_PROVIDER_ID,
  SLACK_PROVIDER_ID,
  buildTiles,
  configuredRecord,
  filterTiles,
  slackTile,
  tileCounts,
  type SlackBridgeLike
} from "./_lib";

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
    usable: true,
    ...overrides
  };
}

describe("buildTiles", () => {
  test("excludes the generic provider (surfaced as the Add MCP server action)", () => {
    const tiles = buildTiles([provider({ id: "generic", label: "Generic" }), provider({})], [], 0);
    expect(tiles.map((t) => t.provider.id)).toEqual(["linear"]);
  });

  test("configured + usable record -> connected with 'Connected' status", () => {
    const [tile] = buildTiles([provider({})], [connector({ usable: true })], 0);
    expect(tile!.connected).toBe(true);
    expect(tile!.state).toBe("connected");
    expect(tile!.status).toBe("Connected");
  });

  test("configured + unhealthy record -> needs-attention with message", () => {
    const [tile] = buildTiles(
      [provider({})],
      [connector({ health: "unhealthy", usable: false, message: "API key invalid" })],
      0
    );
    expect(tile!.connected).toBe(true);
    expect(tile!.state).toBe("needs-attention");
    expect(tile!.status).toBe("API key invalid");
  });

  test("configured + unknown health + probe provider -> needs-attention 'Checking...'", () => {
    const [tile] = buildTiles(
      [provider({ hasProbe: true })],
      [connector({ health: "unknown", usable: false })],
      0
    );
    expect(tile!.connected).toBe(true);
    expect(tile!.state).toBe("needs-attention");
    expect(tile!.status).toBe("Checking…");
  });

  test("configured + unhealthy with no message -> 'Validation failed'", () => {
    const [tile] = buildTiles(
      [provider({})],
      [connector({ health: "unhealthy", usable: false, message: undefined })],
      0
    );
    expect(tile!.state).toBe("needs-attention");
    expect(tile!.status).toBe("Validation failed");
  });

  test("non-configured record does not connect the tile", () => {
    const [tile] = buildTiles([provider({})], [connector({ status: "disabled", usable: false })], 0);
    expect(tile!.connected).toBe(false);
    expect(tile!.state).toBe("available");
    expect(tile!.status).toBeNull();
  });

  test("externallySatisfied provider is connected with no record (hosted Google)", () => {
    const [tile] = buildTiles([provider({ externallySatisfied: true })], [], 0);
    expect(tile!.connected).toBe(true);
    expect(tile!.state).toBe("connected");
  });

  test("Google status line counts registry accounts (all signed in)", () => {
    const google = provider({ id: GOOGLE_PROVIDER_ID, label: "Google Workspace OAuth", externallySatisfied: true });
    const tile1 = buildTiles([google], [], 1, 1)[0]!;
    expect(tile1.status).toBe("1 account connected");
    expect(tile1.state).toBe("connected");
    const tile2 = buildTiles([google], [], 2, 2)[0]!;
    expect(tile2.status).toBe("2 accounts connected");
    expect(tile2.state).toBe("connected");
  });

  test("Google with some accounts needing reconnection -> connected with reconnect count", () => {
    const google = provider({ id: GOOGLE_PROVIDER_ID, label: "Google Workspace OAuth", externallySatisfied: true });
    const tile = buildTiles([google], [], 3, 2)[0]!;
    expect(tile.state).toBe("connected");
    expect(tile.status).toBe("2 connected, 1 needs reconnection");
  });

  test("Google with ALL accounts needing reconnection -> needs-attention", () => {
    const google = provider({ id: GOOGLE_PROVIDER_ID, label: "Google Workspace OAuth", externallySatisfied: true });
    const tile = buildTiles([google], [], 2, 0)[0]!;
    expect(tile.state).toBe("needs-attention");
    expect(tile.status).toBe("Accounts need reconnection");
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

  test("needs-attention tile is still counted as connected for chip filtering", () => {
    const tiles = buildTiles(
      [provider({})],
      [connector({ health: "unhealthy", usable: false, message: "expired" })],
      0
    );
    expect(tiles[0]!.connected).toBe(true);
    expect(tileCounts(tiles)).toEqual({ all: 1, connected: 1, available: 0 });
  });
});

function slackBridge(overrides: Partial<SlackBridgeLike>): SlackBridgeLike {
  return { id: "bridge_test", kind: "slack", status: "configured", ...overrides };
}

describe("slackTile", () => {
  test("configured bridge with teamName -> connected, named status", () => {
    const tile = slackTile([slackBridge({ metadata: { teamName: "Open Curiosity" } })]);
    expect(tile.provider.id).toBe(SLACK_PROVIDER_ID);
    expect(tile.state).toBe("connected");
    expect(tile.connected).toBe(true);
    expect(tile.status).toBe("Connected — Open Curiosity");
  });

  test("configured bridge without teamName -> connected, plain status", () => {
    const tile = slackTile([slackBridge({ metadata: {} })]);
    expect(tile.state).toBe("connected");
    expect(tile.status).toBe("Connected");
  });

  test("errored bridge -> needs-attention with the status message", () => {
    const tile = slackTile([slackBridge({ status: "error", message: "Socket auth failed" })]);
    expect(tile.state).toBe("needs-attention");
    expect(tile.connected).toBe(true);
    expect(tile.status).toBe("Socket auth failed");
  });

  test("disabled bridge with no message -> needs-attention fallback", () => {
    const tile = slackTile([slackBridge({ status: "disabled" })]);
    expect(tile.state).toBe("needs-attention");
    expect(tile.status).toBe("Needs attention");
  });

  test("configured wins over a co-existing errored bridge", () => {
    const tile = slackTile([
      slackBridge({ status: "error", message: "stale" }),
      slackBridge({ status: "configured", metadata: { teamName: "Acme" } })
    ]);
    expect(tile.state).toBe("connected");
    expect(tile.status).toBe("Connected — Acme");
  });

  test("no slack bridge -> available (description shown, not counted connected)", () => {
    const tile = slackTile([]);
    expect(tile.state).toBe("available");
    expect(tile.connected).toBe(false);
    expect(tile.status).toBeNull();
    expect(tile.provider.description).toBe("DM Gini in your Slack workspace.");
    // Non-slack bridges are ignored.
    expect(slackTile([{ id: "b_tg", kind: "telegram", status: "configured" }]).state).toBe("available");
  });

  test("flows through filterTiles / tileCounts like any tile", () => {
    const tiles = [
      ...buildTiles([provider({})], [connector({})], 0),
      slackTile([slackBridge({ metadata: { teamName: "Open Curiosity" } })])
    ];
    expect(tileCounts(tiles)).toEqual({ all: 2, connected: 2, available: 0 });
    // Search matches the "Slack" label.
    expect(filterTiles(tiles, "all", "slack").map((t) => t.provider.id)).toEqual([SLACK_PROVIDER_ID]);
    // An available slack tile lands in the Available chip.
    const withAvailable = [...buildTiles([provider({})], [], 0), slackTile([])];
    expect(tileCounts(withAvailable)).toEqual({ all: 2, connected: 0, available: 2 });
    expect(filterTiles(withAvailable, "available", "slack").map((t) => t.provider.id)).toEqual([SLACK_PROVIDER_ID]);
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

  test("no matches -> empty list (empty state)", () => {
    expect(filterTiles(tiles, "all", "zzz")).toHaveLength(0);
  });
});
