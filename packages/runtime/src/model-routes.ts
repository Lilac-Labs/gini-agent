// Model-first catalog: invert the provider catalog into a per-model route
// list (see ADR model-first-selection.md).
//
// The provider catalog (src/provider.ts) is provider-major: each provider
// row carries the model ids it serves. The picker UX is model-major: the
// user picks a MODEL, and a provider is just a route that serves it. This
// module folds the configured slice of the catalog into that shape:
//
//   gpt-5.5            → codex
//   claude-sonnet-4-6  → anthropic, bedrock (us/eu/apac/global profiles)
//
// Pure over the providerCatalogWithStatus() output so it is fully testable
// without env/credential games — configured-ness is decided by the caller.

import { providerDisplayLabel } from "./provider";
import type { ModelCatalogEntry, ModelRoute, ProviderCatalogItem, ProviderName } from "./types";

// Hand-curated equivalences between provider-specific model ids and the
// canonical model name the picker shows. Kept explicit (no prefix-stripping
// heuristics) so a new catalog id never silently merges with the wrong
// model. Bedrock's cross-region inference profiles are the same Anthropic
// models the first-party API serves; the geo prefix is a routing choice,
// so it surfaces as a route `qualifier` rather than a separate model.
// Exported so the catalog-drift test can assert every alias key still
// exists in the provider catalog.
export const MODEL_ALIASES: Record<string, Record<string, { id: string; qualifier?: string }>> = {
  bedrock: {
    "us.anthropic.claude-opus-4-8": { id: "claude-opus-4-8", qualifier: "us" },
    "us.anthropic.claude-opus-4-7": { id: "claude-opus-4-7", qualifier: "us" },
    "us.anthropic.claude-sonnet-4-6": { id: "claude-sonnet-4-6", qualifier: "us" },
    "us.anthropic.claude-haiku-4-5-20251001-v1:0": { id: "claude-haiku-4-5", qualifier: "us" },
    "eu.anthropic.claude-sonnet-4-6": { id: "claude-sonnet-4-6", qualifier: "eu" },
    "apac.anthropic.claude-sonnet-4-6": { id: "claude-sonnet-4-6", qualifier: "apac" },
    "global.anthropic.claude-sonnet-4-6": { id: "claude-sonnet-4-6", qualifier: "global" }
  }
};

// Resolve the first-party Anthropic-API model id that mirrors a given
// Bedrock model id, if one exists. The Bedrock cross-region inference
// profiles (us/eu/apac/global prefixes) are the same Anthropic models the
// first-party Messages API serves, so this is the general bridge the
// Bedrock↔Anthropic failover (raceBedrockWithAnthropic in provider.ts) uses
// to build its mirror provider — keyed off the same alias table the picker
// uses, so it stays correct for every aliased model rather than one hardcoded
// id. Returns undefined for a Bedrock model with no first-party equivalent
// (e.g. a non-Anthropic Bedrock model), which the caller treats as "no race".
export function anthropicMirrorModelId(bedrockModelId: string): string | undefined {
  return MODEL_ALIASES.bedrock?.[bedrockModelId]?.id;
}

// Default-route preference, most-preferred first: the model vendor's own
// API beats a reseller/aggregator (first-party endpoints get new model
// revisions and features first), codex's OAuth bundle beats the metered
// clouds, and openrouter/local are deliberate opt-ins that should never
// win a tie. Unknown providers sort last in catalog order.
const ROUTE_PRIORITY = ["openai", "anthropic", "deepseek", "atlascloud", "codex", "azure", "bedrock", "openrouter", "local"] as const;

function routePriority(provider: ProviderCatalogItem["name"]): number {
  const index = (ROUTE_PRIORITY as readonly string[]).indexOf(provider);
  return index === -1 ? ROUTE_PRIORITY.length : index;
}

function routeLabel(provider: ProviderCatalogItem["name"], qualifier?: string): string {
  // ProviderCatalogItem.name is open (`| string`); the exhaustive switch in
  // providerDisplayLabel returns undefined at runtime for a name outside
  // ProviderName, so fall back to the raw name rather than "undefined".
  const base = providerDisplayLabel(provider as ProviderName) || String(provider);
  return qualifier ? `${base} · ${qualifier}` : base;
}

// Fold the status-enriched provider catalog into model-major entries.
// Only configured providers contribute routes — the picker must never
// offer a route the next chat turn can't authenticate. Entry order is
// first appearance in the catalog; route order within an entry is
// ROUTE_PRIORITY, then catalog order, with routes[0] flagged `default`.
export function buildModelCatalog(
  items: Array<ProviderCatalogItem & { configured: boolean }>
): ModelCatalogEntry[] {
  const entries = new Map<string, ModelRoute[]>();
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.configured) continue;
    for (const providerModelId of item.models) {
      const alias = MODEL_ALIASES[item.name]?.[providerModelId];
      const canonicalId = alias?.id ?? providerModelId;
      // Dedupe identical (provider, model) pairs — duplicated catalog rows
      // must not produce twin routes.
      const routeKey = `${item.name}::${providerModelId}`;
      if (seen.has(routeKey)) continue;
      seen.add(routeKey);
      const route: ModelRoute = {
        provider: item.name,
        providerModelId,
        label: routeLabel(item.name, alias?.qualifier),
        default: false
      };
      const routes = entries.get(canonicalId);
      if (routes) routes.push(route);
      else entries.set(canonicalId, [route]);
    }
  }
  return [...entries.entries()].map(([id, routes]) => {
    // Stable sort: catalog order breaks priority ties, so two routes from
    // the same provider (bedrock geo profiles) keep their catalog order.
    const sorted = routes
      .map((route, index) => ({ route, index }))
      .sort((a, b) => routePriority(a.route.provider) - routePriority(b.route.provider) || a.index - b.index)
      .map(({ route }) => route);
    sorted[0] = { ...sorted[0]!, default: true };
    return { id, routes: sorted };
  });
}
