# ADR: Transient Provider Fallback (An Unconfigured Provider Degrades, It Doesn't Block)

- **Status:** Accepted
- **Date:** 2026-06-16
- **See also:** [Per-Agent Provider Settings](./per-agent-provider-settings.md), [Model-First Selection](./model-first-selection.md), [BFF Trust Boundary For Privileged POSTs](./bff-trust-boundary.md)

## Decision

When the provider a turn would dispatch through — the agent override, or absent
one the instance `config.provider` — is **not configured** but **another
provider is**, the runtime transparently dispatches through a configured
provider for that turn and surfaces a banner, instead of failing the turn or
forcing the user to `/setup`. The fallback is **transient**: neither
`config.provider` nor the agent override is ever rewritten, so the user's
selection (and the "finish configuring it" nudge) persists until they add the
missing credential.

Four pieces:

1. **`resolveDispatchProvider(config)`** (`packages/runtime/src/provider.ts`) — pure. Returns the
   active provider when `providerHealth(config).configured`; otherwise the first
   `configured`, non-`echo`, non-self provider from `providerCatalogWithStatus`
   (model = that provider's catalog default); otherwise the active provider
   unchanged (nothing else is usable). Never writes config.
2. **Resolution applies it** in `resolveEffectiveContext`
   (`packages/runtime/src/execution/effective-context.ts`) on BOTH the agent-pinned and instance
   branches, recording `providerFallback?: { selected, using }` on
   `EffectiveContext`. `chat-task.ts` passes the resolved `effective.provider` to
   every generator (the instance path previously passed `undefined`), and
   `providerOverrideForRuntime` returns the fallback so memory LLM side-calls
   degrade too rather than throwing.
3. **The BFF setup gate is fallback-aware.** `getSetupStatus`
   (`packages/runtime/src/runtime/setup-api.ts`) reports
   `providerConfigured = isRealProvider && (active configured || a configured
   fallback exists)`, plus `selectedProvider` / `activeProvider` / `usingFallback`.
   `packages/web/src/proxy.ts` is unchanged — it still reads only `providerConfigured`, so
   it now redirects to `/setup` only when NO provider is usable.
4. **The fallback is surfaced.** `status()` / `RuntimeStatus` carry
   `providerFallback`; `packages/web/src/components/ProviderFallbackBanner.tsx` renders
   "<Selected> isn't configured — using <Using>. Finish setup in Settings."

## Context

Provider resolution previously dispatched the selected provider verbatim with no
credential check: an unconfigured active provider (e.g. bedrock with no AWS key)
reached its transport and threw a provider-auth error on every turn, and the BFF
setup gate — keyed on the active provider alone — `307`'d every top-level
navigation to `/setup` even when a configured provider (deepseek, codex) was
already present. A user whose selected provider lost or never had credentials was
hard-blocked despite having a working provider configured. This replaces the
"an override to an unconfigured provider simply fails at the next turn" behavior
previously documented in [Per-Agent Provider Settings](./per-agent-provider-settings.md).

## Why Transient, Not Persisted

The fallback is computed per-turn and never mutates `config.provider` or the
agent override. This keeps the user's intent intact (they picked their provider
for a reason), keeps the banner/nudge live until they finish setup, and lets
`providerHealth(config).configured` flipping true be the single signal that setup
is complete. (Contrast `removeSetupProvider`, which DOES persist a fallback to
codex/echo — that is the explicit provider-*removal* path, not this.)

## Landmines Preserved

- `echo` is never a fallback candidate (it always reports unconfigured); `azure`
  and `local` report configured only when they are the active provider, so they
  are never selected as a fallback for a different provider.
- The proxy's fail-open contract is unchanged: a failed `/api/setup/status` fetch
  (`null`) still means "no redirect"; only `providerConfigured === false`
  redirects; `/setup` and `/api/*` stay exempt. Only the *value* of
  `providerConfigured` changed.
- When the active agent is pinned to a configured provider but the instance
  default is unconfigured, setup-status reports `usingFallback` (so the proxy
  doesn't redirect) while the per-agent banner stays hidden (that agent
  dispatches its own healthy provider) — both correct. The setup gate is
  instance-level; the banner is active-agent level.

## Consequences

- An unconfigured selected provider degrades gracefully to a configured one
  instead of failing every turn; the app loads instead of forcing `/setup`.
- Provider-auth error tagging and cost/trace records name the fallback provider
  that actually served, not the unconfigured selection.
- A genuinely-unconfigured instance (no provider usable at all) still hits the
  `/setup` gate, unchanged — the fallback only suppresses the redirect when a
  real configured provider exists.

## Acceptance Checks

- `resolveDispatchProvider`: active configured → no fallback; active unconfigured
  with a configured candidate → falls back to it (never `echo`, never an inactive
  `azure`/`local`); nothing configured → no fallback (active unchanged). Never
  writes config.
- `GET /api/setup/status`: `providerConfigured` is true when a configured
  fallback exists, with `usingFallback` / `selectedProvider` / `activeProvider`
  set; it stays false (and the `/setup` redirect stands) when nothing is usable.
- A turn whose resolved provider is unconfigured dispatches through the fallback
  and completes; `/api/status.providerFallback` is `{ selected, using }`; the web
  banner renders the pair; `config.provider` and the agent override are unchanged
  afterward.
- `bun run typecheck` and `bun run test` are green.

## Critical Files

- `packages/runtime/src/provider.ts` — `resolveDispatchProvider`.
- `packages/runtime/src/execution/effective-context.ts` — fallback applied in
  `resolveEffectiveContext`; the `providerFallback` field; `providerOverrideForRuntime`.
- `packages/runtime/src/execution/chat-task.ts` — passes the resolved provider to every generator.
- `packages/runtime/src/runtime/setup-api.ts` — fallback-aware `getSetupStatus.providerConfigured`
  + `selectedProvider` / `activeProvider` / `usingFallback`.
- `packages/runtime/src/runtime/index.ts`, `packages/runtime/src/types.ts` — `providerFallback` on `RuntimeStatus`.
- `packages/web/src/components/ProviderFallbackBanner.tsx`,
  `packages/web/src/components/providers.tsx` — the banner.
