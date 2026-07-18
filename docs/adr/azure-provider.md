# Azure OpenAI As A First-Class Provider

## Decision

Azure OpenAI is a dedicated provider named `azure`, alongside `openai`, `codex`, `openrouter`, `deepseek`, and `local`. The provider NAME is the single signal that selects Azure's deployment-scoped routing — no host-sniffing, and no field-presence detection grafted onto the `openai` provider. Three `ProviderConfig` fields (carried by `normalizeProvider` only for `azure`) refine the routing:

- `apiVersion?: string` — the Azure `api-version` query value. Required by Azure on every data-plane call; `normalizeProvider` defaults it to `2024-10-21` (the latest dated GA for deployment-scoped chat completions, universally supported across regions and SDKs) so a config carrying only a base URL + key still routes.
- `deployment?: string` — the Azure deployment name (the path segment under `/openai/deployments/`). Defaults to `model` at the call site when omitted, matching the common case where the deployment is named after the model it serves. `model` stays the real model id so modality/context-window detection keeps working.
- `authScheme?: "bearer" | "api-key"` — the auth header style. `api-key` (the azure default) sends Azure's `api-key: <key>` header for a resource key; `bearer` sends `Authorization: Bearer <key>` for an Entra access token.

Every chat call (tool-calling, structured JSON, vision, and `generateTaskSummary`) routes to:

```
${baseUrl}/openai/deployments/<deployment>/chat/completions?api-version=<apiVersion>
```

Azure has no per-resource default base URL — it is `https://<resource>.openai.azure.com` — so a base URL is **required** and validated at every config-entry boundary (see Guards).

## Context

Azure OpenAI does not expose the flat OpenAI-compatible surface the other providers speak. Three things differ from `api.openai.com`:

1. **URL shape** — requests route per deployment (`/openai/deployments/<name>/...`), not by a `model` field against a flat `/chat/completions`.
2. **Query param** — every call requires `?api-version=<v>`.
3. **Auth header** — a resource key authenticates via `api-key: <key>`, not `Authorization: Bearer`. (Azure also accepts an Entra access token via `Authorization: Bearer`, so the `bearer` scheme is valid too.)

A first-class `azure` provider is the right shape because Azure lets you stand up many deployments (gpt-5.x, gpt-4o, o-series, …) on one resource, and each should be selectable like any other provider's models. Making the provider NAME the routing signal also collapses the host-detection guards an "Azure-mode-of-openai" approach needed: the name disambiguates, so the web settings UI gets a normal provider tile rather than a base-URL-sniffing reveal, and the runtime keys behavior off `provider.name === "azure"` rather than re-deriving "is this Azure?" at each site.

The OpenAI-compatible chat machinery (streaming SSE reader, function-call argument-delta accumulation, vision content shape, structured-output `json_object` mode) is reused unchanged — only the URL and the auth header differ, centralized in two helpers so the four chat-completions builders stay consistent.

## Routing Helpers

Two helpers in `packages/runtime/src/provider.ts` centralize the per-call decision:

- `chatCompletionsUrl(provider, baseUrl)` — returns the Azure deployment-scoped URL for the `azure` provider (percent-encoding the deployment and version), else `${baseUrl}/chat/completions`.
- `chatCompletionsAuthHeader(provider, apiKey)` — returns `{ "api-key": key }` for the `azure` provider unless its `authScheme` is `bearer`, in which case `{ authorization: "Bearer <key>" }`; every other provider uses Bearer. Returns `{}` when no key is present, preserving the keyless-local-gateway path.

`generateTaskSummary` routes the `azure` provider through the chat-completions builder rather than the flat `/responses` surface, because Azure's deployment-scoped chat/completions is the stable, universally-available endpoint. Standard `openai` still uses `/responses` unchanged.

## Guards

Two exported guards run at every config-entry boundary (the `gini provider set` CLI, the `POST /api/setup/provider` endpoint, and the `set_provider` agent tool that funnels through it). Both no-op for non-azure providers, and `normalizeProvider` itself stays a pure, non-throwing transform so config hydration and per-agent override resolution are unaffected:

- `azureNeedsBaseUrl(name, baseUrl)` — true when an `azure` config has no usable base URL. Without a base URL the deployment path can't be built.
- `azureNeedsHttps(name, baseUrl)` — true when an `azure` base URL isn't `https://`. Azure sends a credential on every call (resource key in a plaintext `api-key` header, or an Entra bearer), so a non-https endpoint would leak it. Azure is https across every cloud, so requiring https never blocks a legitimate setup and keeps the guard cloud-agnostic.

## Auth And Secret Storage

The Azure key (or Entra token) is read from the env var named by `apiKeyEnv` (default `AZURE_OPENAI_API_KEY`). The setup API persists it to `~/.gini/secrets.env` and hot-updates `process.env` so the running gateway picks it up on the next call. Because `apiKeyEnv` is user-configurable and is interpolated into the shell-sourced secrets file, `writeKeyToSecretsEnv` / `removeKeyFromSecretsEnv` / `secretsEnvHasKey` validate it against a POSIX env-var-name pattern; the CLI and setup API reject a malformed name with a clear error. Disconnect scrubs the env var the active config actually used (the custom `apiKeyEnv`) in addition to the provider default, so the secret never survives a removal. `apiVersion`, `deployment`, and `authScheme` are non-secret transport config and flow through `providerHealth` / `/api/status` / trace records like `baseUrl`.

## Edit Semantics

`setSetupProvider` resolves transport fields as present-clears / absent-preserves: a key present in the payload (even blank) is applied (blank clears), an absent key preserves the existing value. The web Edit Provider dialog posts the full Azure transport state (base URL, api-version, deployment, auth scheme), so blanking api-version/deployment falls back to the GA default / the model id. A partial `{ provider, model }` save (the model picker, the `set_provider` tool) preserves the persisted routing. A provider switch (different `name`) starts clean, matching the cross-provider non-inheritance rule for agents. Because Azure has no default base URL, the single persisted-config model means switching the active provider away from and back to Azure requires re-confirming the endpoint via Add/Edit (the base-URL guard surfaces a clear error otherwise) rather than silently routing to a wrong default.

## Migration From The openai-Grafted Shape

An earlier release configured Azure as a mode of the `openai` provider —
`{name:"openai", apiVersion, deployment, authScheme, baseUrl:<azure-host>}`.
Because `normalizeProvider` now carries `apiVersion`/`deployment`/`authScheme`
only for the `azure` provider, a persisted config of that shape would otherwise
lose its routing and fall back to the flat `api.openai.com` path. `loadConfig`
(`packages/runtime/src/paths.ts`) detects the legacy shape — an `openai` provider carrying a
non-empty `apiVersion` only ever came from the azure-on-openai path — and
rewrites it once to `{name:"azure", ...}`, persisting the upgrade on load. The
migration **preserves `apiKeyEnv`** (defaulting to `OPENAI_API_KEY`, where the
azure-on-openai flow wrote the key): it only rewrites `config.json` and never
moves the secret in `secrets.env`, so switching `apiKeyEnv` would point the
provider at an empty var and break a working config. This mirrors the existing
`dangerouslyAutoApprove → approvalMode` load-time shim.

## Configured Status

Azure has no default endpoint, so an `AZURE_OPENAI_API_KEY` env var alone is not
a usable config. `isProviderConfigured` therefore reports `azure` as configured
only when it is the ACTIVE provider with a valid persisted https resource
baseUrl — not on the env var alone. Because only the single active provider's
config is persisted, an inactive azure config's baseUrl is unknown, so the
Settings list shows an azure row only while azure is the active, usable provider
(re-add via Add Provider after switching away). This keeps the row truthful and
avoids a radio-switch affordance that could only ever fail (the switch payload
carries no baseUrl). `providerHealth` (which drives `/api/setup/status`) applies
the same valid-https-endpoint check for azure, so the status endpoint and the
catalog agree. Every other provider still reads as configured from its env var,
since each has a working default endpoint.

Because the azure row only renders while azure is active, and the Settings trash
button is disabled for the active provider, azure is **not** in the removable
set (alongside codex and local): a trash button would be a permanently-dead
affordance. Azure is disconnected by switching to another provider (or re-added
via Add Provider); scrubbing the azure key from `secrets.env` is the CLI
`gini provider` path.

## Agent Override Inheritance

`resolveEffectiveContext()` spreads `config.provider` for a same-provider agent override, so an agent that overrides only `model` on an Azure instance inherits `baseUrl`, `apiVersion`, `deployment`, and `authScheme` automatically. A cross-provider override takes `normalizeProvider`'s per-provider defaults and never inherits the Azure routing fields — the same invariant `provider-extra-body.md` documents for `baseUrl` / `apiKeyEnv` / `extraBody`.

## Capabilities

`resolveProviderContextWindowTokens` maps `azure` through the OpenAI model-family windows (Azure hosts the same models). `resolveProviderModality` follows the OpenAI family for vision but pins `nativeDocs: false` — Azure's deployment-scoped chat/completions has no `file` content part, so a native `document` part would 400; image input (vision) still works.

## Out Of Scope

- **Azure embeddings.** The default embedding provider is `local`; Azure embeddings need a separate embeddings deployment (a chat deployment can't serve `text-embedding-3-small`), so they are a distinct follow-up.
- **v1 surface.** Azure's newer undated `/openai/v1/` GA channel is an additive parallel surface; the dated deployment-scoped path remains the broadly compatible default. When Azure explicitly rejects a tool-calling request and directs the client to `/v1/responses`, Gini retries on `/openai/v1/responses` with the same runtime function tools. Web search remains connector-backed (see ADR web-search-connectors.md).

## Consequences

- `azure` is a first-class transport for Azure OpenAI across the full chat surface (tool-calling, structured, vision, summary), configurable via the CLI, the setup API, the `set_provider` tool, and the web Add/Edit Provider forms.
- `provider.name === "azure"` is the single source of truth for Azure routing; any future Azure-specific behavior keys off the name rather than re-deriving the condition from a base URL or a field's presence.
