// Shared provider-catalog types and display helpers.
//
// Both the settings route (ProviderCard / EditProviderDialog / Add Provider)
// and the shared ModelPicker consume the `/providers/catalog` payload, so the
// row shape and the brand-label helper live here rather than inside any one
// route's private component.

import type {
  ModelCatalogEntry as RuntimeModelCatalogEntry,
  ModelRoute as RuntimeModelRoute,
  ProviderAuthStatus,
  ProviderCatalogItem as RuntimeProviderCatalogItem,
  ProviderReauthInfo
} from "@runtime/types";

// The `/providers/catalog` payload is the runtime ProviderCatalogItem enriched
// with a per-row `configured` flag (see providerCatalogWithStatus) and the
// persistent auth status (see withProviderAuthStatus). Derive the client shape
// from the runtime types so the fields can't drift.
//
// `configured` is true when credentials for this provider are available in the
// running gateway (env var set, codex auth.json present, or local explicitly
// activated). Settings hides un-configured rows; Add Provider treats the flag
// as informational.
//
// `authStatus` is "needs_reauth" when the runtime recorded a provider auth
// failure that nothing has cleared yet (issue #233); `reauth` then carries the
// redacted failure detail, its timestamp, and the same reauthKind/reauthUrl
// CTA routing the chat re-auth note uses.
export type ProviderCatalogItem = Pick<
  RuntimeProviderCatalogItem,
  "id" | "name" | "displayName" | "baseUrl" | "auth" | "models" | "setupDocUrl"
> & { configured?: boolean; authStatus?: ProviderAuthStatus; reauth?: ProviderReauthInfo };

// The `/providers/models` payload: canonical models with the routes
// (configured providers) that serve them. Derived from the runtime types so
// the fields can't drift; consumed by the shared ModelPicker. A route is the
// exact { provider, providerModelId } pair the selection endpoints persist.
export type ModelRoute = Pick<
  RuntimeModelRoute,
  "provider" | "providerModelId" | "label" | "default"
>;
export type ModelCatalogEntry = Pick<RuntimeModelCatalogEntry, "id"> & {
  routes: ModelRoute[];
};

// Trim suffixes that the static catalog stacks on top of the brand name.
// The Pencil mocks reference providers by short name (OpenAI, OpenRouter,
// Codex, …); the auth badge alongside each row carries the "how" (OAuth /
// API key / Local) so the brand label doesn't need to repeat it.
export function displayProviderName(item: { displayName: string; name: string }): string {
  if (item.name === "local") return "Local";
  if (item.name === "codex") return "Codex";
  return item.displayName.replace(/\s+Compatible$/i, "");
}

// Short brand label keyed by provider name alone, for surfaces that carry only
// the name (e.g. the fallback banner reading status.providerFallback). Mirrors
// the runtime providerDisplayLabel so the web copy reads the same brands the
// settings rows show; falls back to the raw name for an unknown value.
export function providerBrandLabel(name: string): string {
  const labels: Record<string, string> = {
    codex: "Codex",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    deepseek: "DeepSeek",
    anthropic: "Anthropic",
    bedrock: "Amazon Bedrock",
    azure: "Azure OpenAI",
    local: "Local",
    echo: "Gini Echo"
  };
  return labels[name] ?? name;
}
